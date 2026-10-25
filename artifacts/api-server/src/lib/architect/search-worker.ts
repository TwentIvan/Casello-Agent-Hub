/**
 * Ricerca con espressione regolare isolata in un worker_thread: un pattern patologico (ReDoS)
 * non deve bloccare il processo dell'API. Il codice del worker è una stringa JavaScript
 * autonoma (solo built-in di Node) avviata con `eval: true`: così funziona identico sotto
 * Vitest (sorgente TS) e nel bundle esbuild (dist/index.mjs), senza file separato da
 * trovare a runtime.
 */
import { Worker } from "node:worker_threads";

export const REGEX_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 15_000;

const WORKER_CODE = `
const { parentPort } = require("node:worker_threads");
let files = [];
parentPort.on("message", (m) => {
  if (m.type === "init") {
    files = m.files;
    parentPort.postMessage({ type: "ready" });
    return;
  }
  const re = new RegExp(m.pattern);
  const glob = m.glob ? new RegExp(m.glob) : null;
  const results = [];
  outer: for (const [path, text] of files) {
    if (glob && !glob.test(path)) continue;
    const lines = text.split("\\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > m.maxLine) continue;
      if (!re.test(line)) continue;
      results.push({ path, line: i + 1, text: line.trim().slice(0, m.maxText) });
      if (results.length >= m.max) break outer;
    }
  }
  parentPort.postMessage({ type: "result", id: m.id, results });
});
`;

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export class RegexSearchTimeout extends Error {}
export class RegexSearchUnavailable extends Error {}

export class RegexSearchWorker {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private disabled = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: SearchHit[]) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly files: () => [string, string][]) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.unref();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new RegexSearchUnavailable("worker non pronto"));
      }, READY_TIMEOUT_MS);
      timer.unref();
      worker.on("message", (m: { type: string; id?: number; results?: SearchHit[] }) => {
        if (m.type === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (m.type === "result" && m.id !== undefined) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p?.resolve(m.results ?? []);
        }
      });
      const fail = () => {
        clearTimeout(timer);
        this.kill();
        reject(new RegexSearchUnavailable("worker terminato"));
      };
      worker.on("error", fail);
      worker.on("exit", fail);
    });
    this.ready.catch(() => undefined);
    worker.postMessage({ type: "init", files: this.files() });
    return this.ready;
  }

  /** Termina il worker e fa fallire le ricerche in corso; la ricerca regex resta disabilitata. */
  private kill(): void {
    this.disabled = true;
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate();
    for (const p of this.pending.values()) p.reject(new RegexSearchUnavailable("worker terminato"));
    this.pending.clear();
  }

  async search(
    pattern: string,
    glob: string | null,
    limits: { max: number; maxText: number; maxLine: number },
  ): Promise<SearchHit[]> {
    if (this.disabled) throw new RegexSearchUnavailable("disabilitata");
    await this.start();
    const worker = this.worker;
    if (!worker) throw new RegexSearchUnavailable("worker terminato");
    const id = this.nextId++;
    return new Promise<SearchHit[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new RegexSearchTimeout());
      }, REGEX_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ type: "search", id, pattern, glob, ...limits });
    });
  }

  async dispose(): Promise<void> {
    this.disabled = true;
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new RegexSearchUnavailable("worker terminato"));
    this.pending.clear();
    if (w) await w.terminate();
  }
}
