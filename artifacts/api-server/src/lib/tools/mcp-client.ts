import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger";
import { BodyTooLarge } from "../http-read";
import {
  MAX_RESPONSE_BYTES,
  TOOL_TIMEOUT_MS,
  ToolError,
  fail,
  isPlainObject,
  redact,
  resolveAuthFor,
  truncate,
} from "./executor";
import { declaredLevelFromMcp, type ToolLevel } from "./levels";
import type { AppConnection, CatalogTool, McpDefinition, ToolResult } from "./types";

// Client MCP: Casello interroga (tools/list) e chiama (tools/call) il server MCP di un'app.
// Indirizzo e credenziali arrivano solo dalla connessione dell'app; nessun redirect, risposta
// limitata, timeout. Mai nei log il testo o gli header del servizio: solo nomi e codici di errore.

export const MCP_LIST_TIMEOUT_MS = 30_000;
export const MCP_MAX_TOOLS = 500;

export const MCP_MESSAGES = {
  unreachable: "server MCP non raggiungibile",
  auth: "autenticazione rifiutata dal server MCP",
  notFound: "strumento non trovato sul server MCP",
  invalid: "risposta MCP non valida",
} as const;

const CLIENT_INFO = { name: "casello", version: "1.0.0" } as const;

/** Errore previsto del client MCP: il messaggio è uno di `MCP_MESSAGES`. */
export class McpError extends Error {
  constructor(message: (typeof MCP_MESSAGES)[keyof typeof MCP_MESSAGES]) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpToolInfo {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  level: ToolLevel;
}

/**
 * Indirizzo del server MCP: `mcpUrl`, oppure (con `internalBaseUrl`) l'origine interna con il path
 * di `mcpUrl`. Null se l'app non ha `mcpUrl` o l'indirizzo non è valido.
 */
export function resolveMcpEndpoint(conn: AppConnection): URL | null {
  if (!conn.mcpUrl) return null;
  let url: URL;
  try {
    url = new URL(conn.mcpUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!conn.internalBaseUrl) return url;
  let internal: URL;
  try {
    internal = new URL(conn.internalBaseUrl);
  } catch {
    return null;
  }
  return new URL(`${url.pathname}${url.search}`, internal.origin);
}

/** Header di autenticazione e credenziali da oscurare, con le stesse regole dei tool HTTP. */
export function mcpAuthHeaders(
  conn: AppConnection,
  identity: "user" | "service",
  userToken?: string,
): { headers: Record<string, string>; secrets: string[] } {
  const auth = resolveAuthFor(conn, identity, userToken);
  return { headers: { [auth.header[0]]: auth.header[1] }, secrets: auth.secrets };
}

/** Cosa è successo sul filo, per classificare gli errori dell'SDK senza leggere il testo del servizio. */
interface WireState {
  status: number | null;
  redirected: boolean;
  tooLarge: boolean;
}

/** Oscura le credenziali anche nella forma con gli escape JSON (valori dentro un JSON serializzato). */
function redactWithJson(text: string, secrets: string[]): string {
  return redact(text, [...secrets, ...secrets.map((v) => JSON.stringify(v).slice(1, -1))]);
}

function newWireState(): WireState {
  return { status: null, redirected: false, tooLarge: false };
}

/** `fetch` per il trasporto: niente redirect, timeout, risposta POST limitata in byte. */
function limitedFetch(fetchImpl: typeof fetch, signal: AbortSignal, state: WireState): typeof fetch {
  return async (input, init) => {
    // Nessun flusso SSE autonomo: 405 = "il server non ne offre", l'SDK prosegue senza (niente
    // richiesta con credenziali, niente flusso illimitato, lo stato resta quello delle POST)
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const res = await fetchImpl(input, {
      ...init,
      redirect: "manual",
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });
    state.status = res.status;
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      state.redirected = true;
      throw new Error("redirect non seguito");
    }
    if (init?.method !== "POST" || !res.body) return res;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await res.body.cancel().catch(() => {});
      state.tooLarge = true;
      throw new BodyTooLarge();
    }
    let total = 0;
    const limited = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            state.tooLarge = true;
            controller.error(new BodyTooLarge());
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

type ConnectedClient = { client: Client; signal: AbortSignal };

async function withClient<T>(
  endpoint: URL,
  headers: Record<string, string>,
  state: WireState,
  opts: { fetchImpl?: typeof fetch | undefined; timeoutMs: number; signal?: AbortSignal | undefined },
  fn: (c: ConnectedClient) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: limitedFetch(opts.fetchImpl ?? fetch, signal, state),
    requestInit: { headers },
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, { signal, timeout: opts.timeoutMs });
    return await fn({ client, signal });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Traduce un errore dell'SDK o della rete in un errore con messaggio fisso. */
function classify(err: unknown, state: WireState): { kind: keyof typeof MCP_MESSAGES | "timeout" | "tooLarge" } {
  if (state.tooLarge) return { kind: "tooLarge" };
  if (state.redirected) return { kind: "unreachable" };
  if (state.status === 401 || state.status === 403) return { kind: "auth" };
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
  if (err instanceof SdkMcpError) {
    if (err.code === ErrorCode.RequestTimeout) return { kind: "timeout" };
    if (err.code === ErrorCode.ConnectionClosed) return { kind: "unreachable" };
    if (/not found|unknown tool/i.test(err.message) || err.code === ErrorCode.MethodNotFound) {
      return { kind: "notFound" };
    }
    return { kind: "invalid" };
  }
  if (state.status !== null && state.status >= 400) return { kind: "invalid" };
  if (name === "ZodError" || name === "SyntaxError") return { kind: "invalid" };
  return { kind: "unreachable" };
}

function logFailure(op: string, err: unknown): void {
  const code = err instanceof SdkMcpError ? err.code : undefined;
  logger.warn(
    { op, errName: err instanceof Error ? err.name : "unknown", ...(code !== undefined ? { code } : {}) },
    "Chiamata MCP non riuscita",
  );
}

/** Strumenti del server MCP dell'app: identità di servizio se l'app ha il segreto, altrimenti anonimo. */
export async function listMcpTools(
  conn: AppConnection,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<McpToolInfo[]> {
  const endpoint = resolveMcpEndpoint(conn);
  if (!endpoint) throw new McpError(MCP_MESSAGES.unreachable);
  let headers: Record<string, string> = {};
  let secrets: string[] = [];
  if (conn.serviceAuth && conn.serviceSecretEnc) {
    try {
      ({ headers, secrets } = mcpAuthHeaders(conn, "service"));
    } catch (err) {
      if (err instanceof ToolError) throw new McpError(MCP_MESSAGES.auth);
      throw err;
    }
  }
  const timeoutMs = opts.timeoutMs ?? MCP_LIST_TIMEOUT_MS;
  const state = newWireState();
  try {
    return await withClient(endpoint, headers, state, { fetchImpl: opts.fetchImpl, timeoutMs }, async (c) => {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.client.listTools(cursor ? { cursor } : {}, { signal: c.signal, timeout: timeoutMs });
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            description: t.description ?? null,
            inputSchema: t.inputSchema as Record<string, unknown>,
            level: declaredLevelFromMcp(t),
          });
          if (tools.length > MCP_MAX_TOOLS) throw new McpError(MCP_MESSAGES.invalid);
        }
        cursor = page.nextCursor;
      } while (cursor);
      // Un servizio che rimanda la credenziale in descrizioni o schemi non la porta nel catalogo
      return secrets.length === 0
        ? tools
        : (JSON.parse(redactWithJson(JSON.stringify(tools), secrets)) as McpToolInfo[]);
    });
  } catch (err) {
    if (err instanceof McpError) throw err;
    logFailure("tools/list", err);
    const kind = classify(err, state).kind;
    if (kind === "auth") throw new McpError(MCP_MESSAGES.auth);
    if (kind === "unreachable" || kind === "timeout") throw new McpError(MCP_MESSAGES.unreachable);
    throw new McpError(MCP_MESSAGES.invalid);
  }
}

/** Testo di un risultato `tools/call`: testi e `structuredContent` concatenati, il resto omesso. */
function renderResult(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result["content"])) {
    for (const block of result["content"]) {
      if (isPlainObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      } else {
        const type = isPlainObject(block) && typeof block["type"] === "string" ? block["type"] : "sconosciuto";
        parts.push(`[contenuto ${type} omesso]`);
      }
    }
  }
  if (result["structuredContent"] !== undefined) parts.push(JSON.stringify(result["structuredContent"]));
  return parts.join("\n");
}

export async function callMcpTool(input: {
  conn: AppConnection;
  tool: CatalogTool;
  args: Record<string, unknown>;
  userToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ToolResult> {
  const { conn, tool } = input;
  const timeoutMs = input.timeoutMs ?? TOOL_TIMEOUT_MS;
  const endpoint = resolveMcpEndpoint(conn);
  if (!endpoint) return fail("l'app non ha un server MCP configurato");
  const mcpName = (tool.definition as McpDefinition).mcpName;

  let auth: { headers: Record<string, string>; secrets: string[] };
  try {
    auth = mcpAuthHeaders(conn, tool.identity, input.userToken);
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message);
    return fail("errore interno nell'esecuzione del tool");
  }

  const state = newWireState();
  try {
    const text = await withClient(
      endpoint,
      auth.headers,
      state,
      { fetchImpl: input.fetchImpl, timeoutMs, signal: input.signal },
      async (c) => {
        const res = await c.client.callTool({ name: mcpName, arguments: input.args }, undefined, {
          signal: c.signal,
          timeout: timeoutMs,
        });
        return { text: redactWithJson(renderResult(res), auth.secrets), isError: res["isError"] === true };
      },
    );
    return text.isError
      ? fail(truncate(text.text || "errore del servizio"))
      : { ok: true, content: truncate(text.text === "" ? "(risposta vuota)" : text.text) };
  } catch (err) {
    logFailure("tools/call", err);
    const kind = classify(err, state).kind;
    if (kind === "tooLarge") return fail(`risposta troppo grande (oltre ${MAX_RESPONSE_BYTES} byte)`);
    if (kind === "timeout") {
      return fail(`timeout: l'app non ha risposto entro ${Math.round(timeoutMs / 100) / 10} s`);
    }
    if (kind === "unreachable" || kind === "auth" || kind === "notFound" || kind === "invalid") {
      return fail(MCP_MESSAGES[kind]);
    }
    return fail(MCP_MESSAGES.invalid);
  }
}
