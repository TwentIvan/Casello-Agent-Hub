import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCasello } from "./test/fake-casello";
import { tempDir } from "./test/helpers";
import {
  applyUpdate,
  checkUpdateOnStart,
  DRAIN_MAX_MS,
  fetchDownloader,
  isValidVersion,
  markUpdateHealthy,
  readFailedVersion,
  updatePaths,
  type ApplyUpdateDeps,
  type UpdateInfo,
  type UpdatePaths,
} from "./updater";

let home: string;
let cleanup: () => Promise<void>;
let paths: UpdatePaths;
let casello: FakeCasello;

const OLD = Buffer.from("#!programma vecchio 0.3.0\n");
const NEW = Buffer.from("#!programma nuovo 0.4.0\n".repeat(50));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const NOW = new Date("2026-11-10T10:00:00.000Z");

beforeEach(async () => {
  ({ dir: home, cleanup } = await tempDir("casello-upd-"));
  paths = updatePaths(home);
  await mkdir(path.dirname(paths.programPath), { recursive: true });
  await writeFile(paths.programPath, OLD, { mode: 0o755 });
  casello = new FakeCasello();
  await casello.start();
});
afterEach(async () => {
  await casello.close();
  await cleanup();
});

function serve(body: Buffer, pathname = "/downloads/nodo/casello-nodo-0.4.0") {
  casello.on("GET", pathname, (_req, res) => {
    res.statusCode = 200;
    res.end(body);
  });
}

function update(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return { version: "0.4.0", sha256: sha(NEW), size: NEW.length, required: false, ...over };
}

function deps(over: Partial<ApplyUpdateDeps> = {}): ApplyUpdateDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    caselloUrl: casello.url,
    currentVersion: "0.3.0",
    paths,
    download: fetchDownloader(),
    drain: vi.fn(async () => {
      order.push("drain");
      return true;
    }),
    interrupt: vi.fn(async () => {
      order.push("interrupt");
    }),
    resume: vi.fn(() => {
      order.push("resume");
    }),
    exit: vi.fn((code: number) => {
      order.push(`exit:${code}`);
    }),
    now: () => NOW,
    ...over,
  };
}

async function programIsOld(): Promise<void> {
  expect(await readFile(paths.programPath)).toEqual(OLD);
  expect(existsSync(paths.downloadPath)).toBe(false);
}

describe("applyUpdate", () => {
  it("scarica dall'indirizzo della config, verifica, aspetta il lavoro, sostituisce, tiene .prev ed esce con 0", async () => {
    serve(NEW);
    const d = deps();
    await applyUpdate(update(), d);
    expect(casello.calls("GET", "/downloads/nodo/casello-nodo-0.4.0")).toHaveLength(1);
    expect(casello.requests[0].headers.authorization).toBeUndefined();
    expect(await readFile(paths.programPath)).toEqual(NEW);
    expect(await readFile(paths.prevPath)).toEqual(OLD);
    expect(existsSync(paths.downloadPath)).toBe(false);
    expect(d.drain).toHaveBeenCalledWith(DRAIN_MAX_MS);
    expect(d.order).toEqual(["drain", "exit:0"]);
    expect(JSON.parse(await readFile(paths.updateJsonPath, "utf8"))).toEqual({
      from: "0.3.0",
      to: "0.4.0",
      startedAt: NOW.toISOString(),
      starts: 0,
    });
  });

  it("sha256 diverso → file scaricato rimosso, programma intatto, nessuna attesa del lavoro", async () => {
    serve(NEW);
    const d = deps();
    await expect(applyUpdate(update({ sha256: "0".repeat(64) }), d)).rejects.toThrow("non corrisponde");
    await programIsOld();
    expect(d.drain).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("risposta più lunga di size → download interrotto, programma intatto", async () => {
    serve(Buffer.concat([NEW, Buffer.alloc(100_000, 1)]));
    const d = deps();
    await expect(applyUpdate(update(), d)).rejects.toThrow();
    await programIsOld();
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("risposta più corta di size → errore, programma intatto", async () => {
    serve(NEW.subarray(0, 10));
    await expect(applyUpdate(update(), deps())).rejects.toThrow();
    await programIsOld();
  });

  it("redirect dal server → errore senza seguirlo, programma intatto", async () => {
    casello.on("GET", "/downloads/nodo/casello-nodo-0.4.0", (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/altrove");
      res.end();
    });
    serve(NEW, "/altrove");
    await expect(applyUpdate(update(), deps())).rejects.toThrow();
    await programIsOld();
    expect(casello.calls("GET", "/altrove")).toHaveLength(0);
  });

  it("HTTP 404 → errore, programma intatto", async () => {
    await expect(applyUpdate(update(), deps())).rejects.toThrow();
    await programIsOld();
  });

  it("versione non valida → nessuna richiesta, nessun percorso costruito", async () => {
    const download = vi.fn();
    for (const version of ["../../etc/passwd", "0.4", "0.4.0/x", "", "1.2.3 "]) {
      await expect(applyUpdate(update({ version }), deps({ download }))).rejects.toThrow("versione");
    }
    expect(download).not.toHaveBeenCalled();
  });

  it("dimensione oltre 300 MB o sha256 malformato → rifiutati prima del download", async () => {
    const download = vi.fn();
    await expect(applyUpdate(update({ size: 301 * 1024 * 1024 }), deps({ download }))).rejects.toThrow();
    await expect(applyUpdate(update({ sha256: "xyz" }), deps({ download }))).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
  });

  it("non obbligatorio e lavoro ancora in corso dopo l'attesa → riprende il lavoro, programma intatto", async () => {
    serve(NEW);
    const d = deps({ drain: vi.fn(async () => false) });
    await expect(applyUpdate(update(), d)).rejects.toThrow("lavoro");
    expect(d.resume).toHaveBeenCalled();
    expect(d.interrupt).not.toHaveBeenCalled();
    await programIsOld();
  });

  it("sostituzione non riuscita → update.json tolto, file scaricato rimosso, programma intatto, lavoro ripreso", async () => {
    serve(NEW);
    // .prev occupato da una cartella non vuota: il rename di .prev fallisce prima di toccare il programma
    await mkdir(path.join(paths.prevPath, "occupato"), { recursive: true });
    const d = deps();
    await expect(applyUpdate(update(), d)).rejects.toThrow("sostituzione del programma non riuscita");
    expect(existsSync(paths.updateJsonPath)).toBe(false);
    expect(d.resume).toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
    await programIsOld();
  });

  it("sostituzione non riuscita dopo un'interruzione → update.json tolto ed uscita 1", async () => {
    serve(NEW);
    await mkdir(path.join(paths.prevPath, "occupato"), { recursive: true });
    const d = deps({ drain: vi.fn(async () => false) });
    await applyUpdate(update({ required: true }), d);
    expect(existsSync(paths.updateJsonPath)).toBe(false);
    expect(d.order).toEqual(["interrupt", "exit:1"]);
    await programIsOld();
  });

  it("errore prima di update.json → una versione fallita già registrata resta", async () => {
    serve(NEW);
    await writeFile(paths.updateJsonPath, JSON.stringify({ failedVersion: "0.3.5" }));
    const d = deps({ drain: vi.fn(async () => false) });
    await expect(applyUpdate(update(), d)).rejects.toThrow("lavoro");
    expect(readFailedVersion(paths)).toBe("0.3.5");
  });

  it("obbligatorio e lavoro oltre l'attesa → interruzione come uno stop, poi sostituzione ed uscita", async () => {
    serve(NEW);
    const d = deps();
    d.drain = vi.fn(async () => {
      d.order.push("drain");
      return false;
    });
    await applyUpdate(update({ required: true }), d);
    expect(d.order).toEqual(["drain", "interrupt", "exit:0"]);
    expect(await readFile(paths.programPath)).toEqual(NEW);
  });
});

describe("checkUpdateOnStart / markUpdateHealthy", () => {
  async function writeOpen(startedAt: Date, starts = 0) {
    await writeFile(paths.prevPath, OLD);
    await writeFile(paths.programPath, NEW);
    await writeFile(paths.updateJsonPath, JSON.stringify({ from: "0.3.0", to: "0.4.0", startedAt: startedAt.toISOString(), starts }));
  }

  it("senza update.json → ok", () => {
    expect(checkUpdateOnStart(paths, NOW)).toBe("ok");
    expect(readFailedVersion(paths)).toBeUndefined();
  });

  it("tre avvii entro 2 minuti senza heartbeat riuscito → ripristina .prev e registra la versione fallita", async () => {
    await writeOpen(NOW);
    expect(checkUpdateOnStart(paths, new Date(NOW.getTime() + 10_000))).toBe("ok");
    expect(checkUpdateOnStart(paths, new Date(NOW.getTime() + 30_000))).toBe("ok");
    expect(await readFile(paths.programPath)).toEqual(NEW);
    expect(checkUpdateOnStart(paths, new Date(NOW.getTime() + 50_000))).toBe("rolled_back");
    expect(await readFile(paths.programPath)).toEqual(OLD);
    expect(existsSync(paths.prevPath)).toBe(false);
    expect(JSON.parse(await readFile(paths.updateJsonPath, "utf8"))).toMatchObject({ failedVersion: "0.4.0" });
    expect(readFailedVersion(paths)).toBe("0.4.0");
    // Il programma ripristinato riparte normalmente
    expect(checkUpdateOnStart(paths, new Date(NOW.getTime() + 70_000))).toBe("ok");
    expect(await readFile(paths.programPath)).toEqual(OLD);
  });

  it("primo heartbeat riuscito → update.json chiuso, nessun ritorno indietro", async () => {
    await writeOpen(NOW);
    expect(checkUpdateOnStart(paths, NOW)).toBe("ok");
    markUpdateHealthy(paths);
    expect(existsSync(paths.updateJsonPath)).toBe(false);
    for (let i = 0; i < 3; i++) expect(checkUpdateOnStart(paths, NOW)).toBe("ok");
    expect(await readFile(paths.programPath)).toEqual(NEW);
  });

  it("avvii oltre 2 minuti dall'aggiornamento → nessun ritorno indietro", async () => {
    await writeOpen(NOW, 2);
    expect(checkUpdateOnStart(paths, new Date(NOW.getTime() + 3 * 60_000))).toBe("ok");
    expect(await readFile(paths.programPath)).toEqual(NEW);
  });

  it("markUpdateHealthy non cancella la versione fallita registrata", async () => {
    await writeFile(paths.updateJsonPath, JSON.stringify({ failedVersion: "0.4.0", from: "0.3.0", to: "0.4.0" }));
    markUpdateHealthy(paths);
    expect(readFailedVersion(paths)).toBe("0.4.0");
  });

  it("update.json illeggibile → ok, nessun errore", async () => {
    await writeFile(paths.updateJsonPath, "{rotto");
    expect(checkUpdateOnStart(paths, NOW)).toBe("ok");
    expect(readFailedVersion(paths)).toBeUndefined();
  });
});

it("isValidVersion", () => {
  expect(isValidVersion("0.4.0")).toBe(true);
  expect(isValidVersion("1.20.300-beta.1")).toBe(true);
  expect(isValidVersion("1.2")).toBe(false);
  expect(isValidVersion("1.2.3/..")).toBe(false);
  expect(isValidVersion("x".repeat(50))).toBe(false);
});
