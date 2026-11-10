import { SourceError } from "../architect/sources";
import { readBytesLimited } from "../http-read";

const COMMIT_TIMEOUT_MS = 10_000;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export interface FetchBranchShaInput {
  apiBase: string;
  /** proprietario/nome, già validato da chi ha preso il token. */
  repo: string;
  /** Branch dell'app; vuoto o null = HEAD (branch predefinito). */
  branch: string | null;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sha (minuscolo, 40 caratteri) dell'ultimo commit del branch, letto da GitHub con il token dato.
 * Lancia `SourceError`: `status` 401/403/404 dalla risposta, null per rete, timeout o risposta non valida.
 */
export async function fetchBranchSha(input: FetchBranchShaInput): Promise<string> {
  const doFetch = input.fetchImpl ?? fetch;
  const ref = (input.branch?.trim() || "HEAD").split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await doFetch(`${input.apiBase}/repos/${input.repo}/commits/${ref}`, {
      headers: {
        accept: "application/vnd.github.sha",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "casello",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? COMMIT_TIMEOUT_MS),
    });
  } catch {
    throw new SourceError("GitHub non raggiungibile");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("lettura del commit non riuscita", [401, 403, 404].includes(res.status) ? res.status : null);
  }
  try {
    const body = new TextDecoder("utf-8").decode(await readBytesLimited(res, 4096)).trim();
    // Con `application/vnd.github.sha` il corpo è lo sha; se GitHub risponde in JSON, il campo `sha`
    const sha = body.startsWith("{") ? (JSON.parse(body) as { sha?: unknown }).sha : body;
    if (typeof sha === "string" && FULL_SHA_RE.test(sha)) return sha.toLowerCase();
  } catch {
    // corpo illeggibile: stessa risposta di uno sha non valido
  }
  throw new SourceError("risposta di GitHub non valida");
}
