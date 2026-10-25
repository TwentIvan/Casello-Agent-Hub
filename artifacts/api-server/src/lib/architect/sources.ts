import YAML from "yaml";
import { BodyTooLarge, readBytesLimited } from "../http-read";
import { SOURCE_LIMITS, SourceTree, SourceTreeError } from "./source-tree";

/**
 * Sorgenti dell'architetto: zipball di GitHub (token di sola lettura) e documento OpenAPI
 * dell'app. Tutto ciò che arriva da qui è dato non attendibile; il token non compare mai in
 * messaggi di errore o log e non viene inoltrato a host diversi da quello delle API GitHub.
 */

export class SourceError extends Error {
  /** Stato HTTP della risposta che ha causato l'errore (401/403/404 dal download GitHub), se c'è. */
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
}

const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 120_000;
const OPENAPI_TIMEOUT_MS = 10_000;
const MAX_OPENAPI_BYTES = 2_097_152;
const MAX_REDIRECTS = 3;
const MAX_OPENAPI_CANDIDATES = 12;
const MAX_DESCRIBE_CHARS = 8_000;
const MAX_REF_DEPTH = 3;
const MAX_RESOLVE_NODES = 20_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Repo GitHub nel formato proprietario/nome, senza segmenti `.` o `..` (usato anche al salvataggio dell'app). */
export function isValidGithubRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo) && !repo.split("/").some((s) => s === "." || s === "..");
}

export const OPENAPI_PATHS = [
  "/openapi.json",
  "/api/openapi.json",
  "/openapi.yaml",
  "/api/openapi.yaml",
  "/swagger.json",
  "/api-docs",
];

function isTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** Solo il codice di rete (es. ECONNREFUSED): mai URL, header o messaggi che potrebbero contenere il token. */
function describeNetworkError(err: unknown, target: string, timeoutMs: number): string {
  if (isTimeout(err)) return `timeout: ${target} non ha risposto entro ${Math.round(timeoutMs / 100) / 10} s`;
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
  return `errore di rete verso ${target}${code}`;
}

export async function fetchGithubTree(input: {
  repo: string;
  branch: string | null;
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Solo per i test: limite ridotto dell'archivio. */
  maxZipBytes?: number;
}): Promise<SourceTree> {
  if (!isValidGithubRepo(input.repo)) {
    throw new SourceError("repo GitHub non valido: atteso il formato proprietario/nome");
  }
  const [owner, name] = input.repo.split("/") as [string, string];
  const apiBase = new URL(input.apiBase ?? GITHUB_API);
  const allowHttp = apiBase.protocol === "http:";
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const maxZip = input.maxZipBytes ?? SOURCE_LIMITS.maxZipBytes;
  const prefix = apiBase.pathname.replace(/\/+$/, "");
  const ref = input.branch ? `/${encodeURIComponent(input.branch)}` : "";

  let url = new URL(
    `${apiBase.origin}${prefix}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/zipball${ref}`,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let redirects = 0;
  for (;;) {
    // Il token viaggia solo verso l'host delle API GitHub, mai verso l'host di un redirect
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "casello-architetto",
    };
    if (url.origin === apiBase.origin) headers["authorization"] = `Bearer ${input.token}`;
    try {
      res = await fetchImpl(url.toString(), { method: "GET", headers, redirect: "manual", signal });
    } catch (err) {
      throw new SourceError(describeNetworkError(err, "GitHub", timeoutMs));
    }
    if (res.status < 300 || res.status >= 400) break;
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (!location || redirects >= MAX_REDIRECTS) throw new SourceError("redirect GitHub non valido o troppo lungo");
    redirects++;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new SourceError("redirect GitHub non valido o troppo lungo");
    }
    if (next.protocol !== "https:" && !(allowHttp && next.protocol === "http:")) {
      throw new SourceError("redirect GitHub non valido: solo https");
    }
    url = next;
  }

  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("token GitHub non valido o senza accesso al repo", res.status);
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("repo o branch non trovato", 404);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError(`errore GitHub (${res.status})`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBytesLimited(res, maxZip);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      throw new SourceError(`archivio troppo grande (oltre ${Math.round(maxZip / 1_048_576)} MB)`);
    }
    throw new SourceError(describeNetworkError(err, "GitHub", timeoutMs));
  }
  try {
    return SourceTree.fromZip(bytes, { stripTopFolder: true });
  } catch (err) {
    if (err instanceof SourceTreeError) throw new SourceError(err.message);
    throw err;
  }
}

// --- OpenAPI ---------------------------------------------------------------------------

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
}

export interface OpenApiDoc {
  source: string;
  operations: OpenApiOperation[];
  raw: object;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function candidateUrls(openapiUrl: string | null, baseUrls: string[]): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  if (openapiUrl) {
    const u = parseHttpUrl(openapiUrl);
    if (u) add(u.toString());
  }
  for (const raw of baseUrls) {
    const base = parseHttpUrl(raw);
    if (!base) continue;
    const prefix = base.pathname.replace(/\/+$/, "");
    for (const p of OPENAPI_PATHS) add(new URL(`${base.origin}${prefix}${p}`).toString());
  }
  return out.slice(0, MAX_OPENAPI_CANDIDATES);
}

function parseDocument(text: string): object | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = YAML.parse(text, { maxAliasCount: 50 });
    } catch {
      return null;
    }
  }
  if (!isObj(value)) return null;
  if (typeof value["openapi"] !== "string" && typeof value["swagger"] !== "string") return null;
  return value;
}

function listOperations(raw: object): OpenApiOperation[] {
  const paths = (raw as Record<string, unknown>)["paths"];
  const ops: OpenApiOperation[] = [];
  if (!isObj(paths)) return ops;
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const m of HTTP_METHODS) {
      const op = Object.hasOwn(item, m) ? item[m] : undefined;
      if (!isObj(op)) continue;
      ops.push({
        method: m.toUpperCase(),
        path,
        operationId: typeof op["operationId"] === "string" ? op["operationId"] : null,
        summary: typeof op["summary"] === "string" ? op["summary"] : null,
      });
    }
  }
  return ops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
}

export async function fetchOpenApi(input: {
  openapiUrl: string | null;
  baseUrls: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OpenApiDoc | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? OPENAPI_TIMEOUT_MS;
  for (const url of candidateUrls(input.openapiUrl, input.baseUrls)) {
    try {
      // Solo GET, nessuna credenziale, nessun redirect (il content-type non è attendibile)
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json, application/yaml, text/yaml, */*" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const bytes = await readBytesLimited(res, MAX_OPENAPI_BYTES);
      const raw = parseDocument(new TextDecoder("utf-8").decode(bytes));
      if (raw) return { source: url, operations: listOperations(raw), raw };
    } catch {
      // candidato non raggiungibile, troppo grande o scaduto: si passa al successivo
    }
  }
  return null;
}

function resolvePointer(root: unknown, ref: string): unknown {
  let cur: unknown = root;
  for (const rawSeg of ref.slice(2).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return undefined;
    }
    seg = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    } else if (isObj(cur) && Object.hasOwn(cur, seg)) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

const MAX_WALK_DEPTH = 64;
const MAX_WALK_CHARS = 16_000;

/**
 * Copia di `value` con i `$ref` locali risolti (profondità ≤ 3, cicli e riferimenti esterni lasciati
 * come segnaposto). Il documento è non attendibile: un budget di caratteri (chiavi e stringhe) ferma
 * la costruzione appena l'output supera il necessario, e la profondità di annidamento è limitata.
 */
function resolveRefs(root: unknown, value: unknown): unknown {
  let nodes = MAX_RESOLVE_NODES;
  let chars = MAX_WALK_CHARS;
  const walk = (v: unknown, depth: number, stack: string[], nest: number): unknown => {
    if (--nodes < 0 || chars < 0) return "…";
    if (nest > MAX_WALK_DEPTH) return "(annidamento troppo profondo)";
    if (typeof v === "string") {
      chars -= v.length;
      // Una stringa enorme non viene mai copiata per intero
      return v.length > MAX_WALK_CHARS ? `${v.slice(0, 200)}…` : v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        if (chars < 0) {
          out.push("…");
          break;
        }
        out.push(walk(x, depth, stack, nest + 1));
      }
      return out;
    }
    if (!isObj(v)) return v;
    if (typeof v["$ref"] === "string") {
      const ref = v["$ref"];
      if (!ref.startsWith("#/")) return { $ref: "(riferimento non locale)" };
      if (depth >= MAX_REF_DEPTH || stack.includes(ref)) return { $ref: ref };
      const target = resolvePointer(root, ref);
      if (target === undefined) return { $ref: ref };
      return walk(target, depth + 1, [...stack, ref], nest + 1);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (chars < 0) {
        out["…"] = "…";
        break;
      }
      chars -= k.length;
      out[k] = walk(x, depth, stack, nest + 1);
    }
    return out;
  };
  return walk(value, 0, [], 0);
}

/** Descrizione compatta (≤ 8 000 caratteri) di parametri, corpo e risposte di un'operazione. */
export function describeOperation(doc: OpenApiDoc, method: string, path: string): string {
  const paths = (doc.raw as Record<string, unknown>)["paths"];
  const item = isObj(paths) && Object.hasOwn(paths, path) ? paths[path] : undefined;
  const m = method.toLowerCase();
  const op = isObj(item) && Object.hasOwn(item, m) ? item[m] : undefined;
  if (!isObj(item) || !isObj(op) || !HTTP_METHODS.includes(m)) {
    return `operazione ${method.toUpperCase()} ${path} non trovata nel documento OpenAPI`;
  }
  const lines = [`${method.toUpperCase()} ${path}`];
  if (typeof op["operationId"] === "string") lines.push(`operationId: ${op["operationId"]}`);
  if (typeof op["summary"] === "string") lines.push(`summary: ${op["summary"]}`);
  if (typeof op["description"] === "string") lines.push(`description: ${op["description"]}`);
  const params = [
    ...(Array.isArray(item["parameters"]) ? item["parameters"] : []),
    ...(Array.isArray(op["parameters"]) ? op["parameters"] : []),
  ];
  if (params.length) lines.push(`parametri: ${JSON.stringify(resolveRefs(doc.raw, params))}`);
  if (op["requestBody"] !== undefined) {
    lines.push(`corpo: ${JSON.stringify(resolveRefs(doc.raw, op["requestBody"]))}`);
  }
  if (op["responses"] !== undefined) {
    lines.push(`risposte: ${JSON.stringify(resolveRefs(doc.raw, op["responses"]))}`);
  }
  const text = lines.join("\n");
  return text.length <= MAX_DESCRIBE_CHARS ? text : `${text.slice(0, MAX_DESCRIBE_CHARS - 1)}…`;
}
