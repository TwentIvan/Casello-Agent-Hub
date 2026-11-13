import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { logger } from "../logger";
import { guardedLookup } from "../oauth/clients";

export const WEB_TIMEOUT_MS = 10_000;
export const WEB_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_REDIRECTS = 3;
const MAX_URL_CHARS = 2000;
const USER_AGENT = "Botcave/1 (lettore di pagine; +https://casello.fantamister.cloud)";
const ACCEPT = "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1";

export type WebFetchCode = "invalid_url" | "not_allowed" | "unreachable" | "timeout" | "http_status" | "too_many_redirects" | "unsupported_type";
export type BodyKind = "html" | "json" | "text";
export type WebFetchResult =
  | { ok: true; finalUrl: string; kind: BodyKind; charset: string | null; body: Buffer; truncated: boolean; redirects: number }
  | { ok: false; code: WebFetchCode; status?: number };
export type WebFetcher = (url: string) => Promise<WebFetchResult>;
type RequestFn = (u: URL, o: https.RequestOptions) => http.ClientRequest;

/** Controllo puro dell'indirizzo: solo https sulla 443, senza credenziali, verso un nome DNS pubblico (mai IP letterali). */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; code: "invalid_url" | "not_allowed" } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return { ok: false, code: "invalid_url" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "not_allowed" };
  if (url.port !== "" && url.port !== "443") return { ok: false, code: "not_allowed" };
  if (url.username !== "" || url.password !== "") return { ok: false, code: "not_allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "" || net.isIP(host) !== 0) return { ok: false, code: "not_allowed" };
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" || !host.includes(".")) {
    return { ok: false, code: "not_allowed" };
  }
  url.hash = "";
  return { ok: true, url };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function classify(contentType: string | undefined): { kind: BodyKind | "sniff" | null; charset: string | null } {
  if (!contentType) return { kind: "sniff", charset: null };
  const [type = "", ...params] = contentType.split(";");
  const mime = type.trim().toLowerCase();
  let charset: string | null = null;
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(p);
    if (m) charset = m[1]!.toLowerCase();
  }
  if (mime === "text/html" || mime === "application/xhtml+xml") return { kind: "html", charset };
  if (mime === "application/json" || mime.endsWith("+json")) return { kind: "json", charset };
  if (mime === "text/plain" || mime === "text/markdown") return { kind: "text", charset };
  return { kind: null, charset };
}

/**
 * Scarica una pagina pubblica: solo https verso indirizzi pubblici (verificati alla connessione), al più 3 redirect
 * ricontrollati, 10 s in tutto, 2 MiB di corpo. Non lancia mai eccezioni.
 */
export function fetchPage(
  url: string,
  deps: { lookup?: ReturnType<typeof guardedLookup>; request?: RequestFn } = {},
): Promise<WebFetchResult> {
  const started = Date.now();
  const lookup = (deps.lookup ?? guardedLookup()) as unknown as https.RequestOptions["lookup"];
  const doRequest: RequestFn = deps.request ?? ((u, o) => https.request(u, o));

  return new Promise<WebFetchResult>((resolve) => {
    let done = false;
    let current: { destroy(): void } | null = null;
    let host = "";
    let status: number | undefined;
    let bytes = 0;
    let redirects = 0;

    const finish = (result: WebFetchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Log: solo host, stato, byte, redirect, durata ed esito; mai percorso, query o contenuto.
      logger.info(
        { host, status, bytes, redirects, durationMs: Date.now() - started, outcome: result.ok ? "ok" : result.code },
        "pagina web letta",
      );
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        current?.destroy();
      } catch {
        /* già chiusa */
      }
      finish({ ok: false, code: "timeout" });
    }, WEB_TIMEOUT_MS);

    const step = (target: string): void => {
      const checked = checkUrl(target);
      if (!checked.ok) return finish({ ok: false, code: checked.code });
      const u = checked.url;
      host = u.hostname;
      let req: http.ClientRequest;
      try {
        req = doRequest(u, {
          method: "GET",
          headers: { "user-agent": USER_AGENT, accept: ACCEPT, "accept-encoding": "identity" },
          lookup,
        });
      } catch {
        return finish({ ok: false, code: "unreachable" });
      }
      current = req;
      let superseded = false;
      req.on("error", (err: Error) => {
        if (superseded) return; // errore tardivo di una richiesta già sostituita dal redirect
        const msg = err instanceof Error ? err.message : "";
        finish({ ok: false, code: msg.includes("indirizzo non ammesso") ? "not_allowed" : "unreachable" });
      });
      req.on("response", (res: http.IncomingMessage) => {
        current = res;
        status = res.statusCode ?? 0;
        res.on("error", () => {
          if (!superseded) finish({ ok: false, code: "unreachable" });
        });
        const header = (name: string): string | undefined => {
          const v = res.headers[name];
          return Array.isArray(v) ? v[0] : v;
        };

        if (REDIRECT_STATUSES.has(status)) {
          const location = header("location");
          let next: string | null = null;
          if (location) {
            try {
              next = new URL(location, u).toString();
            } catch {
              next = null;
            }
          }
          if (next !== null) {
            // Il corpo del 3xx non serve: si chiude subito (resume() lo leggerebbe senza limiti, fuori da tempo e tetto).
            superseded = true;
            res.destroy();
            if (redirects >= WEB_MAX_REDIRECTS) return finish({ ok: false, code: "too_many_redirects" });
            redirects++;
            return step(next);
          }
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          return finish({ ok: false, code: "http_status", status });
        }
        const encoding = header("content-encoding")?.trim().toLowerCase();
        const cls = classify(header("content-type"));
        if ((encoding && encoding !== "identity") || cls.kind === null) {
          res.destroy();
          return finish({ ok: false, code: "unsupported_type" });
        }

        const chunks: Buffer[] = [];
        let truncated = false;
        const complete = () => {
          const body = Buffer.concat(chunks);
          let kind: BodyKind;
          if (cls.kind === "sniff") {
            kind = body.toString("utf8", 0, 64).trimStart().startsWith("<") ? "html" : "text";
          } else {
            kind = cls.kind!;
          }
          finish({ ok: true, finalUrl: u.toString(), kind, charset: cls.charset, body, truncated, redirects });
        };
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          const room = WEB_MAX_BYTES - bytes;
          if (c.length > room) {
            chunks.push(c.subarray(0, room));
            bytes += room;
            truncated = true;
            res.destroy();
            complete();
            return;
          }
          chunks.push(c);
          bytes += c.length;
        });
        res.on("end", () => {
          if (!truncated) complete();
        });
      });
      req.end();
    };

    step(url);
  });
}
