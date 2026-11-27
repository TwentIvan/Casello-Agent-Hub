// Client del protocollo del runner (/api/collaudo/*). Il token del collaudo resta solo in memoria; gli errori hanno
// messaggi fissi senza token né corpo delle risposte. Un 401 su qualunque chiamata = collaudo chiuso o annullato.

import type { TestRecipe } from "./recipe-run";

export type ClaimPackage = {
  token: string;
  repo: string;
  sha: string;
  repoToken: string;
  recipe: TestRecipe | null;
  mode: "full" | "relight";
};

export type RunnerCommand = { id: number; kind: string; args: Record<string, unknown> };
export type NextResult = { type: "command"; command: RunnerCommand } | { type: "none" } | { type: "delivered"; liveLink: boolean };
export type FileKind = "screenshot" | "video";

/** Collaudo chiuso, annullato o codice rifiutato: si ferma tutto, senza report. */
export class CollaudoClosedError extends Error {
  constructor() {
    super("collaudo chiuso o annullato");
    this.name = "CollaudoClosedError";
  }
}

/** Risposta inattesa di Botcave (stato HTTP noto) o rete non raggiungibile (status 0). */
export class CollaudoHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? "Botcave non raggiungibile" : `risposta inattesa da Botcave (HTTP ${status})`);
    this.name = "CollaudoHttpError";
  }
}

const CALL_TIMEOUT_MS = 30_000;
/** Più dell'attesa lunga del server (25 s). */
const NEXT_TIMEOUT_MS = 40_000;
const FILE_TIMEOUT_MS = 120_000;

export class CollaudoClient {
  private token: string | null = null;

  constructor(private readonly baseUrl: string) {}

  private async call(
    route: string,
    init: { body?: unknown; raw?: Buffer; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: Uint8Array | string | undefined;
    if (init.raw) {
      headers["content-type"] = "application/octet-stream";
      body = new Uint8Array(init.raw);
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const timeout = AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/collaudo/${route}`, { method: "POST", headers, body, signal, redirect: "error" });
    } catch {
      throw new CollaudoHttpError(0);
    }
    if (res.status === 401) {
      await res.body?.cancel();
      throw new CollaudoClosedError();
    }
    return res;
  }

  private async expect(res: Response, ...ok: number[]): Promise<void> {
    if (!ok.includes(res.status)) {
      await res.body?.cancel();
      throw new CollaudoHttpError(res.status);
    }
  }

  async claim(testId: number, code: string): Promise<ClaimPackage> {
    const res = await this.call("claim", { body: { testId, code } });
    await this.expect(res, 200);
    const pkg = (await res.json()) as ClaimPackage;
    if (typeof pkg?.token !== "string" || typeof pkg.repo !== "string" || typeof pkg.sha !== "string") throw new CollaudoHttpError(200);
    this.token = pkg.token;
    return pkg;
  }

  async next(signal?: AbortSignal): Promise<NextResult> {
    const res = await this.call("next", { timeoutMs: NEXT_TIMEOUT_MS, signal });
    if (res.status === 204) return { type: "none" };
    if (res.status === 410) {
      // `liveLink` falso (nessun esito da provare dal vivo): niente tunnel; senza il campo vale il comportamento di prima
      let liveLink = true;
      try {
        liveLink = ((await res.json()) as { liveLink?: unknown })?.liveLink !== false;
      } catch {
        // corpo non JSON: resta vero
      }
      return { type: "delivered", liveLink };
    }
    await this.expect(res, 200);
    const cmd = (await res.json()) as RunnerCommand;
    if (typeof cmd?.id !== "number" || typeof cmd.kind !== "string") throw new CollaudoHttpError(200);
    return { type: "command", command: { id: cmd.id, kind: cmd.kind, args: cmd.args && typeof cmd.args === "object" ? cmd.args : {} } };
  }

  /** false se Botcave non conosce più il comando (404: scaduto o annullato). */
  async result(commandId: number, r: { ok: boolean; output: string }): Promise<boolean> {
    const res = await this.call(`results/${commandId}`, { body: r });
    if (res.status === 404) {
      await res.body?.cancel();
      return false;
    }
    await this.expect(res, 204);
    return true;
  }

  async ping(): Promise<void> {
    const res = await this.call("ping", {});
    await this.expect(res, 200);
    await res.body?.cancel();
  }

  async tunnel(url: string, until: string): Promise<void> {
    await this.expect(await this.call("tunnel", { body: { url, until } }), 204);
  }

  async uploadFile(kind: FileKind, name: string, bytes: Buffer): Promise<{ id: number }> {
    const res = await this.call("files", {
      raw: bytes,
      headers: { "x-file-kind": kind, "x-file-name": encodeURIComponent(name) },
      timeoutMs: FILE_TIMEOUT_MS,
    });
    await this.expect(res, 201);
    const saved = (await res.json()) as { id?: unknown };
    if (typeof saved?.id !== "number") throw new CollaudoHttpError(201);
    return { id: saved.id };
  }

  async report(status: "done" | "failed"): Promise<void> {
    await this.expect(await this.call("report", { body: { status } }), 204);
  }
}
