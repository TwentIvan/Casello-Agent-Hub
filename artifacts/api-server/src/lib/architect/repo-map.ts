import YAML from "yaml";
import type { SourceTree } from "./source-tree";
import type { OpenApiDoc } from "./sources";

/**
 * Mappa deterministica del repository, calcolata una volta per analisi e data a ogni fase: il
 * modello parte da qui invece di ricostruire albero, punti d'ingresso e operazioni con i tool.
 * Tutto ciò che contiene (README, package.json, summary OpenAPI) è dato del repository, non
 * istruzioni, e non finisce mai nei log.
 */

export const REPO_MAP_MAX_CHARS = 32_000;
const ENTRY_POINTS_MAX_CHARS = 8_000;
const OPENAPI_MAX_CHARS = 32_000;
const TRUNCATED_MARKER = "[...mappa troncata: usa list_dir]";
const OPENAPI_TRUNCATED_MARKER = "[...elenco troncato: usa list_operations]";
const DIR_THRESHOLDS = [25, 10, 5];
const LARGEST_FILES_SHOWN = 5;
const MAX_SUMMARY_EXTENSIONS = 3;
const MAX_SUMMARY_CHARS = 150;
const MAX_DEPENDENCIES = 30;
const MAX_PACKAGE_JSONS = 20;
const MAX_DOCKER_PATHS = 30;
const MAX_README_LINES = 40;
const MAX_LINE_CHARS = 200;
const READ_ALL = { maxLines: 20_000, maxChars: 500_000 };

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", java: "Java", rb: "Ruby", php: "PHP", cs: "C#", sql: "SQL",
  css: "CSS", scss: "CSS", html: "HTML", md: "Markdown", json: "JSON", yaml: "YAML", yml: "YAML",
};

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** Numero con separatore delle migliaia (spazio), senza dipendere dalla lingua di sistema. */
function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function languageOf(path: string): string {
  const ext = extensionOf(path);
  return LANGUAGES[ext] ?? (ext || "testo");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Tiene le righe intere che stanno nel tetto (marcatore compreso) e aggiunge il marcatore se ne scarta. */
function capLines(lines: string[], max: number, marker: string): string {
  const full = lines.join("\n");
  if (full.length <= max) return full;
  const kept: string[] = [];
  let size = marker.length;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return [...kept, marker].join("\n");
}

// --- 1. Albero ---

interface DirNode {
  files: { name: string; lines: number; ext: string }[];
}

function groupByDir(files: { path: string; lines: number }[]): Map<string, DirNode> {
  const dirs = new Map<string, DirNode>();
  const ensure = (dir: string): DirNode => {
    let node = dirs.get(dir);
    if (!node) dirs.set(dir, (node = { files: [] }));
    return node;
  };
  for (const { path, lines } of files) {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash + 1);
    // Ogni cartella antenata ha la sua riga, anche se contiene solo sottocartelle
    for (let i = dir.indexOf("/"); i >= 0; i = dir.indexOf("/", i + 1)) ensure(dir.slice(0, i + 1));
    ensure(dir).files.push({ name: path.slice(slash + 1), lines, ext: extensionOf(path) });
  }
  ensure("");
  return dirs;
}

function summaryOf(node: DirNode): string {
  const counts = new Map<string, number>();
  let lines = 0;
  for (const f of node.files) {
    counts.set(f.ext, (counts.get(f.ext) ?? 0) + 1);
    lines += f.lines;
  }
  const label = (ext: string) => (ext ? `.${ext}` : "senza estensione");
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  let exts: string;
  if (sorted.length === 1) {
    exts = ` ${label(sorted[0]![0])}`;
  } else {
    const shown = sorted.slice(0, MAX_SUMMARY_EXTENSIONS).map(([ext, n]) => `${fmt(n)} ${label(ext)}`);
    const others = sorted.slice(MAX_SUMMARY_EXTENSIONS).reduce((sum, [, n]) => sum + n, 0);
    if (others > 0) shown.push(`${fmt(others)} altri`);
    exts = `: ${shown.join(", ")}`;
  }
  return `(${fmt(node.files.length)} file${exts}, ${fmt(lines)} righe)`;
}

function renderTree(dirs: Map<string, DirNode>, threshold: number): string[] {
  const out: string[] = [];
  for (const dir of [...dirs.keys()].sort()) {
    const node = dirs.get(dir)!;
    const compressed = node.files.length > threshold;
    out.push(`${dir === "" ? "./" : dir}${compressed ? ` ${summaryOf(node)}` : ""}`);
    const shown = compressed
      ? [...node.files].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1)).slice(0, LARGEST_FILES_SHOWN)
      : [...node.files].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const f of shown) out.push(`  ${f.name} (${fmt(f.lines)} righe, ${languageOf(f.name)})`);
  }
  return out;
}

function treeSection(tree: SourceTree, maxChars: number): string {
  const title = "## Albero dei file (esclusi lockfile, file generati, test e minificati)";
  const files = tree.fileLines();
  if (files.length === 0) return `${title}\n(nessun file)`;
  const dirs = groupByDir(files);
  let lines: string[] = [];
  for (const threshold of DIR_THRESHOLDS) {
    lines = renderTree(dirs, threshold);
    if (title.length + 1 + lines.join("\n").length <= maxChars) break;
  }
  return `${title}\n${capLines(lines, maxChars - title.length - 1, TRUNCATED_MARKER)}`;
}

// --- 2. Punti d'ingresso ---

function readAll(tree: SourceTree, path: string): string {
  return tree.read(path, 1, undefined, READ_ALL).content;
}

function cut(text: string, max = MAX_LINE_CHARS, ellipsis = "…"): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}${ellipsis}` : oneLine;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function packageJsonLines(tree: SourceTree, path: string): string[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readAll(tree, path));
  } catch {
    return [`${path} non leggibile`];
  }
  if (!isRecord(pkg)) return [`${path} non leggibile`];
  const name = typeof pkg["name"] === "string" ? cut(pkg["name"], 100) : "(senza nome)";
  const out = [`${path}: ${name}`];
  if (isRecord(pkg["scripts"])) {
    for (const [script, cmd] of Object.entries(pkg["scripts"])) {
      if (typeof cmd === "string") out.push(`  ${cut(script, 60)}: ${cut(cmd)}`);
    }
  }
  if (isRecord(pkg["dependencies"])) {
    const names = Object.keys(pkg["dependencies"]);
    const shown = names.slice(0, MAX_DEPENDENCIES).map((n) => cut(n, 80));
    if (names.length > 0) {
      out.push(`  dependencies: ${shown.join(", ")}${names.length > shown.length ? `, … (${names.length} in tutto)` : ""}`);
    }
  }
  return out;
}

function workspaceLines(tree: SourceTree, path: string): string[] {
  try {
    const doc: unknown = YAML.parse(readAll(tree, path));
    const packages = isRecord(doc) && Array.isArray(doc["packages"]) ? doc["packages"] : [];
    const entries = packages.filter((p): p is string => typeof p === "string").map((p) => cut(p, 100));
    return [`${path}: ${entries.length ? entries.join(", ") : "nessuna voce in packages"}`];
  } catch {
    return [`${path} non leggibile`];
  }
}

function envNames(tree: SourceTree, path: string): string[] {
  const names: string[] = [];
  for (const line of readAll(tree, path).split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) names.push(m[1]!);
  }
  return [`${path} (solo nomi): ${names.length ? names.join(", ") : "nessuna variabile"}`];
}

/** Risorsa di un percorso OpenAPI: primo segmento dopo un eventuale `/api`. */
function resourceOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "api") segments.shift();
  return segments[0] ?? "(radice)";
}

function countByResource(items: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of items) {
    const r = resourceOf(path);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return counts;
}

function openApiFileLines(tree: SourceTree, path: string): string[] {
  try {
    const doc: unknown = YAML.parse(readAll(tree, path));
    const paths = isRecord(doc) && isRecord(doc["paths"]) ? doc["paths"] : {};
    const operations: string[] = [];
    for (const [p, item] of Object.entries(paths)) {
      if (!isRecord(item)) continue;
      for (const method of Object.keys(item)) if (HTTP_METHODS.has(method.toLowerCase())) operations.push(p);
    }
    const counts = [...countByResource(operations).entries()].map(([r, n]) => `${cut(r, 60)}: ${n} operazioni`);
    return [`${path}: ${counts.length ? counts.join("; ") : "nessuna operazione"}`];
  } catch {
    return [`${path} non leggibile`];
  }
}

function entryPointsSection(tree: SourceTree, hasOpenApiDoc: boolean): string {
  const files = tree.fileLines().map((f) => f.path);
  const lines: string[] = [];

  for (const path of files.filter((p) => baseName(p) === "package.json").slice(0, MAX_PACKAGE_JSONS)) {
    lines.push(...packageJsonLines(tree, path));
  }
  for (const path of files.filter((p) => baseName(p) === "pnpm-workspace.yaml")) {
    lines.push(...workspaceLines(tree, path));
  }
  const docker = files.filter((p) => baseName(p).startsWith("Dockerfile") || /(^|\/)docker\//.test(p) || /\.Dockerfile$/.test(p));
  if (docker.length > 0) {
    const shown = docker.slice(0, MAX_DOCKER_PATHS);
    lines.push(`Docker: ${shown.join(", ")}${docker.length > shown.length ? `, … (${docker.length} in tutto)` : ""}`);
  }
  for (const path of files.filter((p) => /(^|\/)\.env(\.[^/]+)*\.example$/.test(p) || baseName(p) === ".env.example")) {
    lines.push(...envNames(tree, path));
  }
  // Se il documento OpenAPI è già stato caricato c'è la sezione dedicata
  if (!hasOpenApiDoc) {
    for (const path of files.filter((p) => /^openapi\.(ya?ml|json)$/.test(baseName(p)))) {
      lines.push(...openApiFileLines(tree, path));
    }
  }
  if (files.includes("README.md")) {
    const readme = readAll(tree, "README.md").split("\n").slice(0, MAX_README_LINES);
    lines.push("README.md (prime righe):", ...readme.map((l) => `  ${l.slice(0, MAX_LINE_CHARS)}`));
  }

  const title = "## Punti d'ingresso";
  if (lines.length === 0) return `${title}\n(nessun package.json, Dockerfile, .env.example o README di radice)`;
  return `${title}\n${capLines(lines, ENTRY_POINTS_MAX_CHARS - title.length - 1, TRUNCATED_MARKER)}`;
}

// --- 3. Operazioni OpenAPI ---

function operationsSection(openapi: OpenApiDoc): string {
  const title = "## Operazioni OpenAPI (METODO percorso — summary)";
  const ops = openapi.operations;
  if (ops.length === 0) return `${title}\n(nessuna operazione)`;
  const lines = ops.map((op) => {
    const summary = op.summary ? cut(op.summary, MAX_SUMMARY_CHARS, "") : "";
    return `${op.method.toUpperCase()} ${op.path}${summary ? ` — ${summary}` : ""}`;
  });
  if (title.length + 1 + lines.join("\n").length <= OPENAPI_MAX_CHARS) return `${title}\n${lines.join("\n")}`;

  const counts = [...countByResource(ops.map((op) => op.path)).entries()].map(
    ([resource, n]) => `${cut(resource, 60)}: ${n} operazioni`,
  );
  const summaryTitle = `## Operazioni OpenAPI (${ops.length} in tutto, riepilogo per risorsa)`;
  const hint = "usa list_operations per l'elenco";
  const body = capLines(counts, OPENAPI_MAX_CHARS - summaryTitle.length - hint.length - 2, OPENAPI_TRUNCATED_MARKER);
  return `${summaryTitle}\n${body}\n${hint}`;
}

/** Mappa del repository per i prompt delle fasi; "" se non c'è né il codice né l'OpenAPI. */
export function buildRepoMap(tree: SourceTree | null, openapi: OpenApiDoc | null): string {
  const sections: string[] = [];
  if (tree) {
    // I punti d'ingresso hanno il loro tetto; all'albero resta il resto, così senza OpenAPI
    // l'intera mappa sta in REPO_MAP_MAX_CHARS
    const entryPoints = entryPointsSection(tree, openapi !== null);
    sections.push(treeSection(tree, REPO_MAP_MAX_CHARS - entryPoints.length - 2), entryPoints);
  }
  if (openapi) sections.push(operationsSection(openapi));
  return sections.join("\n\n");
}
