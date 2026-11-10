#!/usr/bin/env bash
# Build di Botcave Nodo per Mac (spec §5): bundle CommonJS di casello-nodo come «single executable application» di Node 24
# per arm64 e x64, unite con lipo in un binario universale con firma ad-hoc, poi `Botcave Nodo.app` zippata e il manifest.
# Solo macOS (lipo, codesign, iconutil, sips, ditto). Scrive in docker/nodo-downloads/ (o in $OUT_DIR):
#   Botcave-Nodo-<versione>.zip, casello-nodo-<versione>, nodo-manifest.json
# Variabili facoltative: NODE_BIN (node 24 con cui si genera il blob: la stessa versione viene scaricata da nodejs.org),
# OUT_DIR. Richiede pnpm (bundle) e npx (postject) nel PATH e la rete verso nodejs.org e npm.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-app.sh: serve macOS (lipo, codesign, iconutil)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$NODO_DIR/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/docker/nodo-downloads}"
NODE_BIN="${NODE_BIN:-node}"
POSTJECT="postject@1.0.0-alpha.6"
SENTINEL="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
APP_NAME="Botcave Nodo"

VERSION="$("$NODE_BIN" -p "require('$NODO_DIR/package.json').version")"
MIN_VERSION="$(tr -d '[:space:]' < "$NODO_DIR/min-version.txt")"
NODE_VERSION="$("$NODE_BIN" -p process.version)"
if [[ ! "$NODE_VERSION" =~ ^v24\. ]]; then
  echo "build-app.sh: serve Node 24 (trovato $NODE_VERSION con $NODE_BIN): imposta NODE_BIN" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$MIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-app.sh: versione ($VERSION) o versione minima ($MIN_VERSION) non valida" >&2
  exit 1
fi
echo "Botcave Nodo $VERSION (minima $MIN_VERSION) con Node $NODE_VERSION"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/botcave-nodo-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 1. Bundle CommonJS e blob SEA (senza cache del codice né snapshot: lo stesso blob vale per le due architetture)
(cd "$NODO_DIR" && pnpm run build:sea)
(cd "$NODO_DIR" && "$NODE_BIN" --experimental-sea-config app/sea-config.json)
BLOB="$NODO_DIR/dist/sea-prep.blob"

# 2. Eseguibili ufficiali di Node (stessa versione del blob), verificati con SHASUMS256.txt, con il blob iniettato
DIST_URL="https://nodejs.org/dist/$NODE_VERSION"
curl -fsSL --retry 3 -o "$WORK/SHASUMS256.txt" "$DIST_URL/SHASUMS256.txt"
for arch in arm64 x64; do
  tarball="node-$NODE_VERSION-darwin-$arch.tar.gz"
  curl -fsSL --retry 3 -o "$WORK/$tarball" "$DIST_URL/$tarball"
  expected="$(awk -v f="$tarball" '$2 == f { print $1 }' "$WORK/SHASUMS256.txt")"
  actual="$(shasum -a 256 "$WORK/$tarball" | awk '{ print $1 }')"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "build-app.sh: sha256 di $tarball non corrisponde a SHASUMS256.txt" >&2
    exit 1
  fi
  mkdir -p "$WORK/node-$arch"
  tar -xzf "$WORK/$tarball" -C "$WORK/node-$arch" --strip-components=2 "node-$NODE_VERSION-darwin-$arch/bin/node"
  bin="$WORK/botcave-nodo-$arch"
  cp "$WORK/node-$arch/node" "$bin"
  chmod 755 "$bin"
  codesign --remove-signature "$bin"
  npx --yes "$POSTJECT" "$bin" NODE_SEA_BLOB "$BLOB" --sentinel-fuse "$SENTINEL" --macho-segment-name NODE_SEA
done

# 3. Binario universale con firma ad-hoc, provato in arm64 e in x64 (Rosetta)
BIN="$WORK/botcave-nodo"
lipo -create -output "$BIN" "$WORK/botcave-nodo-arm64" "$WORK/botcave-nodo-x64"
codesign --sign - --force "$BIN"
check_version() { # <comando…>
  local got
  got="$("$@" --version)"
  if [[ "$got" != "$VERSION" ]]; then
    echo "build-app.sh: $* --version ha stampato '$got' invece di '$VERSION'" >&2
    exit 1
  fi
}
check_version arch -arm64 "$BIN"
check_version arch -x86_64 "$BIN"
echo "Prova --version riuscita in arm64 e x64"

# 4. Pacchetto dell'app: eseguibile, Info.plist con la versione e icona da design/icons
APP="$WORK/$APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/botcave-nodo"
sed "s/__VERSION__/$VERSION/g" "$NODO_DIR/app/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
ICON_SRC="$ROOT/design/icons/icon-512.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  # La sorgente è 512 px: la variante @2x di 512 (1024 px) non si ricava senza perdere nitidezza
  if (( double <= 512 )); then
    sips -z "$double" "$double" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
xattr -cr "$APP"
codesign --sign - --force "$APP"
codesign --verify --strict "$APP"

# 5. Zip dell'app, binario da solo e manifest
mkdir -p "$OUT_DIR"
find "$OUT_DIR" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
ZIP_FILE="Botcave-Nodo-$VERSION.zip"
BIN_FILE="casello-nodo-$VERSION"
ditto -c -k --keepParent "$APP" "$OUT_DIR/$ZIP_FILE"
cp "$BIN" "$OUT_DIR/$BIN_FILE"
chmod 755 "$OUT_DIR/$BIN_FILE"
sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
size() { stat -f%z "$1"; }
cat > "$OUT_DIR/nodo-manifest.json" <<EOF
{
  "version": "$VERSION",
  "minVersion": "$MIN_VERSION",
  "binary": { "file": "$BIN_FILE", "sha256": "$(sha "$OUT_DIR/$BIN_FILE")", "size": $(size "$OUT_DIR/$BIN_FILE") },
  "app": { "file": "$ZIP_FILE", "sha256": "$(sha "$OUT_DIR/$ZIP_FILE")", "size": $(size "$OUT_DIR/$ZIP_FILE") }
}
EOF
"$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$OUT_DIR/nodo-manifest.json"
echo "Scritti in $OUT_DIR:"
ls -l "$OUT_DIR"
