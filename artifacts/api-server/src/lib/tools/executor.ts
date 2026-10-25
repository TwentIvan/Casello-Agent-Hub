import { BodyTooLarge, readBytesLimited } from "../http-read";
import { decryptSecret } from "../secrets";
import { checkHttpPath, parseDefinition, validateArgs } from "./definition";
import type { AppConnection, AuthConfig, CatalogTool, HttpDefinition, ToolResult } from "./types";

// Esecutore HTTP dei tool: l'unico punto in cui una chiamata del modello diventa una
// richiesta verso un'app. Host, schema e prefisso arrivano SOLO dalla connessione
// dell'app (internalBaseUrl o baseUrl) e dal path del catalogo; dagli argomenti del
// modello arrivano solo valori, sempre codificati.

export const TOOL_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_RESULT_CHARS = 20_000;

const ERROR_SNIPPET_CHARS = 200;
// Valori più corti non vengono oscurati: si maschererebbero caratteri banali della risposta
const MIN_REDACT_CHARS = 4;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
// Token HTTP (RFC 9110) per i nomi di header
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Header che la configurazione di autenticazione non può sovrascrivere
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "accept",
]);

/** Errore previsto dell'esecutore: il messaggio (in italiano) va restituito al modello. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verifica un indirizzo dell'app (baseUrl o internalBaseUrl): http/https, niente credenziali,
 * query o frammento. Restituisce l'URL o il motivo (in italiano) per cui non è valido.
 * Usata dall'esecutore e dalle route delle app, così le regole sono le stesse al salvataggio.
 */
export function parseAppBaseUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let base: URL;
  try {
    base = new URL(raw.trim());
  } catch {
    return { ok: false, error: "indirizzo dell'app non valido" };
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return { ok: false, error: "indirizzo dell'app non valido: serve http o https" };
  }
  // Un "?" o "#" finali lasciano search/hash vuoti ma restano nel testo
  if (base.search || base.hash || base.username || base.password || /[?#]/.test(raw)) {
    return { ok: false, error: "indirizzo dell'app non valido: niente credenziali, query o frammento" };
  }
  return { ok: true, url: base };
}

/** Motivo (in italiano) per cui un nome di header di autenticazione non è ammesso, o null. */
export function checkAuthHeaderName(header: string): string | null {
  if (!HEADER_NAME.test(header)) return "nome di header non valido";
  if (RESERVED_HEADERS.has(header.toLowerCase())) return `l'header "${header}" è riservato`;
  return null;
}

/** Base dell'app, già verificata (http/https, niente credenziali, query o frammento). */
function resolveBase(conn: AppConnection): { origin: string; path: string } {
  const parsed = parseAppBaseUrl(conn.internalBaseUrl ?? conn.baseUrl ?? "");
  if (!parsed.ok) throw new ToolError(parsed.error);
  const base = parsed.url;
  // Prefisso senza slash finale ("" per la radice): il path del tool inizia sempre con "/"
  return { origin: base.origin, path: base.pathname.replace(/\/+$/, "") };
}

/** Valore di un segnaposto del path, codificato come singolo segmento. */
function encodePathValue(name: string, value: unknown): string {
  if (value === undefined || value === null) {
    throw new ToolError(`parametro "${name}" obbligatorio mancante`);
  }
  if (typeof value === "object") {
    throw new ToolError(`parametro "${name}": un parametro di percorso non può essere un oggetto o un elenco`);
  }
  const str = String(value);
  // encodeURIComponent lascia intatti "." e "..": il parser URL li tratterebbe come dot-segment
  if (str === "" || str === "." || str === "..") {
    throw new ToolError(`parametro "${name}": valore non ammesso in un percorso`);
  }
  try {
    return encodeURIComponent(str);
  } catch {
    // URIError su surrogati UTF-16 isolati
    throw new ToolError(`parametro "${name}": valore non codificabile`);
  }
}

/** Nomi delle proprietà dichiarate nello schema dei parametri. */
function declaredParams(schema: Record<string, unknown>): Set<string> {
  const props = schema["properties"];
  return new Set(isPlainObject(props) ? Object.keys(props) : []);
}

/** Posizione dichiarata di un parametro, senza risalire a Object.prototype. */
function locationOf(def: HttpDefinition, name: string): "path" | "query" | "body" | undefined {
  return Object.hasOwn(def.paramLocations, name) ? def.paramLocations[name] : undefined;
}

function queryValue(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/** Valore dell'header di autenticazione; mai incluso nei messaggi di errore. */
function authHeader(config: AuthConfig, secret: string, what: string): [string, string] {
  if (checkAuthHeaderName(config.header) !== null) {
    throw new ToolError(`header di autenticazione ${what} non valido nella configurazione dell'app`);
  }
  const value = config.scheme ? `${config.scheme} ${secret}` : secret;
  // Solo caratteri visibili ASCII, spazio e tab: niente CR/LF o byte di controllo
  if (!/^[\t\x20-\x7e]+$/.test(value)) {
    throw new ToolError(`${what === "utente" ? "token utente" : "segreto di servizio"} non valido`);
  }
  return [config.header, value];
}

/** Header di autenticazione e credenziali da oscurare nelle risposte (header completo e valore nudo). */
interface ResolvedAuth {
  header: [string, string];
  secrets: string[];
}

function resolveAuth(conn: AppConnection, tool: CatalogTool, userToken?: string): ResolvedAuth {
  if (tool.identity === "service") {
    if (!conn.serviceAuth) {
      throw new ToolError("autenticazione di servizio non configurata per l'app");
    }
    if (!conn.serviceSecretEnc) {
      throw new ToolError("segreto di servizio non configurato per l'app");
    }
    let secret: string;
    try {
      secret = decryptSecret(conn.serviceSecretEnc);
    } catch {
      throw new ToolError("impossibile decifrare il segreto di servizio dell'app");
    }
    const header = authHeader(conn.serviceAuth, secret, "servizio");
    return { header, secrets: [header[1], secret] };
  }
  if (!conn.userAuth) {
    throw new ToolError("autenticazione utente non configurata per l'app");
  }
  if (!userToken) {
    throw new ToolError("token utente mancante: il tool agisce per conto dell'utente");
  }
  const header = authHeader(conn.userAuth, userToken, "utente");
  return { header, secrets: [header[1], userToken] };
}

export function buildHttpRequest(
  conn: AppConnection,
  tool: CatalogTool,
  args: Record<string, unknown>,
  userToken?: string,
): { url: string; init: RequestInit; secrets: string[] } {
  const def = tool.definition as HttpDefinition;
  const pathError = checkHttpPath(def.path);
  if (pathError) throw new ToolError(`definizione del tool non valida: path ${pathError}`);
  const allowsBody = BODY_METHODS.has(def.method);
  if (!allowsBody && Object.values(def.paramLocations).includes("body")) {
    throw new ToolError(
      `definizione del tool non valida: il metodo ${def.method} non ammette parametri nel body`,
    );
  }

  // R9: solo i parametri dichiarati nello schema arrivano all'app (niente mass assignment)
  const declared = declaredParams(tool.paramsSchema);
  const unexpected = Object.keys(args).filter((name) => !declared.has(name));
  if (unexpected.length > 0) {
    throw new ToolError(`parametri non previsti: ${unexpected.join(", ")}`);
  }

  const base = resolveBase(conn);

  // Segnaposto {nome}: solo i parametri dichiarati "path", ciascuno un singolo segmento codificato
  const path = def.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    if (locationOf(def, name) !== "path") {
      throw new ToolError(`definizione del tool non valida: il segnaposto {${name}} non è un parametro di percorso`);
    }
    return encodePathValue(name, Object.hasOwn(args, name) ? args[name] : undefined);
  });

  const url = new URL(`${base.origin}${base.path}${path}`);

  // Difesa in profondità: l'URL finale resta sull'app e sotto il suo prefisso
  const prefix = `${base.path}/`;
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.username || url.password) {
    throw new ToolError("URL della richiesta fuori dall'app: richiesta bloccata");
  }

  const body = Object.create(null) as Record<string, unknown>;
  let hasBody = false;
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    // Parametri senza posizione: querystring per GET/DELETE, body altrimenti
    const location = locationOf(def, name) ?? (allowsBody ? "body" : "query");
    if (location === "path") continue;
    if (location === "query") {
      if (value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(name, queryValue(item));
      } else {
        url.searchParams.append(name, queryValue(value));
      }
    } else {
      body[name] = value;
      hasBody = true;
    }
  }

  const headers = new Headers({ accept: "application/json" });
  const auth = resolveAuth(conn, tool, userToken);
  headers.set(auth.header[0], auth.header[1]);

  const init: RequestInit = { method: def.method, headers, redirect: "manual" };
  if (allowsBody && (hasBody || Object.values(def.paramLocations).includes("body"))) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return { url: url.toString(), init, secrets: auth.secrets };
}

/** Legge il corpo (limitato a MAX_RESPONSE_BYTES) e lo decodifica come UTF-8. */
async function readLimited(res: Response): Promise<string> {
  return new TextDecoder("utf-8").decode(await readBytesLimited(res, MAX_RESPONSE_BYTES));
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [risposta troncata a ${MAX_RESULT_CHARS} caratteri]`;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function pick(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const f of fields) if (Object.hasOwn(obj, f)) out[f] = obj[f];
  return out;
}

/** Proiezione sui campi di primo livello di un oggetto o di ogni oggetto di un array. */
function project(value: unknown, fields: string[] | undefined): unknown {
  if (!fields || fields.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => (isPlainObject(v) ? pick(v, fields) : v));
  if (isPlainObject(value)) return pick(value, fields);
  return value;
}

function errorSnippet(text: string, statusText: string): string {
  const parsed = tryParseJson(text);
  if (parsed.ok && isPlainObject(parsed.value)) {
    for (const key of ["error", "message"]) {
      const v = parsed.value[key];
      if (typeof v === "string" && v.trim()) return v.slice(0, ERROR_SNIPPET_CHARS);
      if (isPlainObject(v) && typeof v.message === "string") return v.message.slice(0, ERROR_SNIPPET_CHARS);
    }
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, ERROR_SNIPPET_CHARS) : statusText || "nessun dettaglio";
}

/**
 * Sostituisce con "***" ogni occorrenza delle credenziali inviate (header completo, token o
 * segreto nudo): un'app può rimandarle in un errore o in una risposta, che finirebbero nel
 * modello, nei passi della run e nello stato del ciclo. Prima i valori più lunghi.
 */
function redact(text: string, secrets: string[]): string {
  let out = text;
  const values = [...new Set(secrets)]
    .filter((v) => v.length >= MIN_REDACT_CHARS)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("***");
  return out;
}

function fail(content: string, status?: number): ToolResult {
  return status === undefined ? { ok: false, content } : { ok: false, status, content };
}

export async function executeTool(input: {
  conn: AppConnection;
  tool: CatalogTool;
  args: unknown;
  userToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ToolResult> {
  const { conn, tool, userToken } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? TOOL_TIMEOUT_MS;

  try {
    if (tool.kind === "ui") return fail("questo tool viene eseguito dal client, non dal server");
    if (tool.kind === "composite") return fail("tool composti non ancora supportati");
    if (tool.kind !== "http") return fail(`tipo di tool non supportato: ${String(tool.kind)}`);

    // La definizione arriva dal DB: la si riverifica prima di usarla
    const parsed = parseDefinition("http", tool.definition);
    if (!parsed.ok) return fail(`definizione del tool non valida: ${parsed.error}`);

    const argError = validateArgs(tool.paramsSchema, input.args);
    if (argError) return fail(`argomenti non validi: ${argError}`);
    if (!isPlainObject(input.args)) return fail("argomenti non validi: devono essere un oggetto");

    const { url, init, secrets } = buildHttpRequest(
      conn,
      { ...tool, definition: parsed.value as HttpDefinition },
      input.args,
      userToken,
    );

    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return fail(describeFetchError(err, timeoutMs));
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return fail(`HTTP ${res.status}: redirect non seguito`, res.status);
    }

    let text: string;
    try {
      text = redact(await readLimited(res), secrets);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        return fail(`risposta troppo grande (oltre ${MAX_RESPONSE_BYTES} byte)`, res.status);
      }
      return fail(describeFetchError(err, timeoutMs), res.status);
    }

    if (!res.ok) {
      return fail(`HTTP ${res.status}: ${redact(errorSnippet(text, res.statusText), secrets)}`, res.status);
    }

    const json = tryParseJson(text);
    const content = json.ok
      ? JSON.stringify(project(json.value, (parsed.value as HttpDefinition).responseFields))
      : text.trim() === ""
        ? "(risposta vuota)"
        : text;
    // Di nuovo dopo JSON.parse/stringify: gli escape JSON possono aver nascosto un valore al primo passaggio
    return { ok: true, status: res.status, content: truncate(redact(content, secrets)) };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message);
    // Errore inatteso: nessun dettaglio che possa contenere token o segreti
    return fail("errore interno nell'esecuzione del tool");
  }
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `timeout: l'app non ha risposto entro ${Math.round(timeoutMs / 100) / 10} s`;
  }
  // Solo il codice dell'errore di rete (es. ECONNREFUSED): mai header o URL completi
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
  return `errore di rete verso l'app${code}`;
}
