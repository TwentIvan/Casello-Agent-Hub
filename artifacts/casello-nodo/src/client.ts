import {
  NodeClaimResponse,
  NodeHeartbeatBody,
  NodeHeartbeatResponse,
  NodePingResponse,
  NodeReportBody,
  NodeTurnClaimResponse,
  NodeTurnReportBody,
} from "@workspace/api-zod";
import type { z } from "zod";

/** Pacchetto di un compito preso in carico, come validato dallo schema del contratto. */
export type TaskPackage = z.infer<typeof NodeClaimResponse>;
export type TaskReport = z.input<typeof NodeReportBody>;
/** Pacchetto di un turno delegato al nodo. */
export type TurnPackage = z.infer<typeof NodeTurnClaimResponse>;
export type TurnReport = z.input<typeof NodeTurnReportBody>;
export type Capabilities = z.input<typeof NodeHeartbeatBody>;

export const LEASE_LOST = "lease non valida o scaduta";

/** 409: la lease non c'è più (scaduta o compito già chiuso). Non si ritenta. */
export class LeaseLostError extends Error {
  constructor() {
    super(LEASE_LOST);
    this.name = "LeaseLostError";
  }
}

/** Risposta 4xx definitiva di Casello (salvo 409 e 429). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    detail: string | null,
  ) {
    super(detail ? `Botcave ha risposto ${status}: ${detail}` : `Botcave ha risposto ${status}`);
    this.name = "HttpError";
  }
}

/**
 * Il compito non è più del nodo: 409 (lease scaduta o compito chiuso/annullato), 401 (token revocato o rigenerato) o
 * 403 (nodo disattivato). Il lavoro si interrompe e non si riferisce: Casello non lo accetterebbe.
 */
export function isLeaseLoss(err: unknown): boolean {
  return err instanceof LeaseLostError || (err instanceof HttpError && (err.status === 401 || err.status === 403));
}

/** Motivo breve della perdita della lease, per il log (solo lo stato HTTP, mai token né lease). */
export function leaseLossReason(err: unknown): string {
  return err instanceof HttpError ? `risposta ${err.status}` : "risposta 409";
}

export class NetworkError extends Error {
  constructor() {
    super("Botcave non raggiungibile");
    this.name = "NetworkError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Timeout di ogni richiesta (default 30 s). */
  timeoutMs?: number;
  /** Attesa complessiva massima tra i nuovi tentativi (default 5 minuti). */
  maxRetryMs?: number;
}

/** Il claim dei turni attende fino a ~50 s lato server: il timeout del client è più largo. */
const TURN_CLAIM_TIMEOUT_MS = 70_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

interface RequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
  readBody?: boolean;
  /** Un solo tentativo: gli errori temporanei passano a chi chiama. */
  noRetry?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class RetryableError extends Error {
  constructor(
    readonly cause: Error,
    readonly retryAfterMs: number | null,
  ) {
    super(cause.message);
  }
}

/** Client del protocollo dei nodi (`/api/node/…`) con il token d'ambito `node`. */
export class CaselloClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetryMs: number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetryMs = opts.maxRetryMs ?? 5 * 60_000;
  }

  async heartbeat(caps: Capabilities): Promise<{ pending: number }> {
    const body = NodeHeartbeatBody.parse(caps);
    const res = await this.request("POST", "/node/heartbeat", { json: body });
    return NodeHeartbeatResponse.parse(await res.json());
  }

  /** Prende in carico un compito; null se non c'è niente da prendere (204). */
  async claim(): Promise<TaskPackage | null> {
    const res = await this.request("POST", "/node/claim", {});
    if (res.status === 204) return null;
    const parsed = NodeClaimResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("pacchetto del compito non valido");
    return parsed.data;
  }

  /** Rinnova la lease; restituisce la nuova scadenza. */
  async ping(taskId: number, leaseToken: string): Promise<Date> {
    const res = await this.request("POST", `/node/tasks/${taskId}/ping`, { json: { leaseToken } });
    return NodePingResponse.parse(await res.json()).leaseExpiresAt;
  }

  async report(taskId: number, report: TaskReport): Promise<void> {
    const body = NodeReportBody.parse(report);
    await this.request("POST", `/node/tasks/${taskId}/report`, { json: body });
  }

  /**
   * Prende un turno delegato (long-poll: Casello attende fino a ~50 s); null se non c'è niente (204). Un solo tentativo:
   * gli errori li gestisce il ciclo dei turni. `signal` interrompe l'attesa.
   */
  async claimTurn(signal?: AbortSignal): Promise<TurnPackage | null> {
    const res = await this.request("POST", "/node/turns/claim", {
      json: {},
      noRetry: true,
      timeoutMs: TURN_CLAIM_TIMEOUT_MS,
      signal,
    });
    if (res.status === 204) return null;
    const parsed = NodeTurnClaimResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("pacchetto del turno non valido");
    return parsed.data;
  }

  /** Rinnova la lease del turno; restituisce la nuova scadenza. */
  async pingTurn(turnId: number, leaseToken: string): Promise<Date> {
    const res = await this.request("POST", `/node/turns/${turnId}/ping`, { json: { leaseToken } });
    return NodePingResponse.parse(await res.json()).leaseExpiresAt;
  }

  async reportTurn(turnId: number, report: TurnReport): Promise<void> {
    const body = NodeTurnReportBody.parse(report);
    await this.request("POST", `/node/turns/${turnId}/report`, { json: body });
  }

  async downloadAttachment(taskId: number, attachmentId: number, leaseToken: string): Promise<Buffer> {
    const res = await this.request("GET", `/node/tasks/${taskId}/attachments/${attachmentId}`, {
      headers: { "X-Lease-Token": leaseToken },
      readBody: true,
    });
    return Buffer.from(await res.arrayBuffer());
  }

  private async request(
    method: string,
    pathname: string,
    opts: RequestOptions,
  ): Promise<Response> {
    let waited = 0;
    let delay = FIRST_DELAY_MS;
    for (;;) {
      try {
        return await this.attempt(method, pathname, opts);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        if (opts.noRetry) throw err.cause;
        const wait = Math.min(err.retryAfterMs ?? delay, MAX_DELAY_MS);
        if (waited + wait > this.maxRetryMs) throw err.cause;
        await this.sleep(wait);
        waited += wait;
        delay = Math.min(delay * 2, MAX_DELAY_MS);
      }
    }
  }

  private async attempt(
    method: string,
    pathname: string,
    opts: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, ...opts.headers };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/api${pathname}`, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        redirect: "error",
        signal,
      });
      if (res.ok && opts.readBody) {
        // Il corpo si legge entro lo stesso timeout: un'interruzione a metà è un errore di rete
        const data = await res.arrayBuffer();
        res = new Response(data, { status: res.status, headers: res.headers });
      }
    } catch {
      throw new RetryableError(new NetworkError(), null);
    }
    if (res.ok) return res;
    const detail = await errorDetail(res);
    if (res.status === 409) throw new LeaseLostError();
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new RetryableError(
        new HttpError(429, detail),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      );
    }
    if (res.status >= 500) throw new RetryableError(new HttpError(res.status, detail), null);
    throw new HttpError(res.status, detail);
  }
}

/** Messaggio `{error}` di Casello (fisso, in italiano), troncato. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error.slice(0, 200) : null;
  } catch {
    return null;
  }
}
