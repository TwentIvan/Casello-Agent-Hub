import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedLookup } from "../oauth/clients";
import { WEB_MAX_BYTES, checkUrl, fetchPage } from "./fetch-page";

type Step = { status?: number; headers?: Record<string, string>; body?: string | Buffer; never?: boolean; error?: boolean; onRes?: (res: Readable) => void };

// Richiesta finta: un passo per ogni richiesta; la `lookup` ricevuta decide se «ci si connette» (con l'host richiesto).
function fakeRequest(steps: Step[], seen: URL[] = []) {
  let i = 0;
  return (u: URL, o: { lookup?: unknown; headers?: unknown }) => {
    seen.push(u);
    const step = steps[Math.min(i++, steps.length - 1)]!;
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.destroy = () => undefined;
    req.end = () => {
      if (step.never) return;
      (o.lookup as ReturnType<typeof guardedLookup>)(u.hostname, {}, (err: unknown) => {
        if (err || step.error) {
          req.emit("error", err ?? new Error("boom"));
          return;
        }
        const body = step.body === undefined ? Buffer.alloc(0) : Buffer.from(step.body);
        const res = Readable.from(body.length ? [body] : []) as Readable & { statusCode?: number; headers?: Record<string, string> };
        res.statusCode = step.status ?? 200;
        res.headers = step.headers ?? {};
        step.onRes?.(res);
        req.emit("response", res);
      });
    };
    return req as never;
  };
}

const PUB = ["93.184.216.34"];
const lookupFor = (map: Record<string, string[]> = {}) =>
  guardedLookup(async (host) => (map[host] ?? PUB).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })));
const run = (url: string, steps: Step[], map?: Record<string, string[]>, seen?: URL[]) =>
  fetchPage(url, { lookup: lookupFor(map), request: fakeRequest(steps, seen) });
const html = { "content-type": "text/html; charset=iso-8859-1" };

afterEach(() => vi.useRealTimers());

describe("checkUrl", () => {
  it("rifiuta indirizzi non ammessi", () => {
    for (const u of [
      "http://a.example",
      "https://a.example:8443/",
      "https://u:p@a.example/",
      "https://10.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://x.localhost/",
      "https://metadata.google.internal/",
      "https://intranet/",
    ]) {
      expect(checkUrl(u), u).toEqual({ ok: false, code: "not_allowed" });
    }
  });
  it("indirizzi non validi", () => {
    expect(checkUrl("non un url")).toEqual({ ok: false, code: "invalid_url" });
    expect(checkUrl("https://a.example/" + "x".repeat(2000))).toEqual({ ok: false, code: "invalid_url" });
  });
  it("toglie il frammento", () => {
    const r = checkUrl("https://herdr.dev/#a");
    expect(r.ok && r.url.hash).toBe("");
  });
});

describe("fetchPage", () => {
  it("200 html con charset", async () => {
    const r = await run("https://a.example/", [{ headers: html, body: "<p>ciao</p>" }]);
    expect(r).toMatchObject({ ok: true, kind: "html", charset: "iso-8859-1", truncated: false, redirects: 0 });
  });

  it("redirect catena e limite", async () => {
    const seen: URL[] = [];
    const ok = await run(
      "https://a.example/",
      [{ status: 301, headers: { location: "/b" } }, { status: 302, headers: { location: "https://a.example/c" } }, { headers: html, body: "x" }],
      undefined,
      seen,
    );
    expect(ok).toMatchObject({ ok: true, redirects: 2, finalUrl: "https://a.example/c" });
    const many = await run("https://a.example/", [{ status: 301, headers: { location: "/b" } }]);
    expect(many).toEqual({ ok: false, code: "too_many_redirects" });
  });

  it("la risposta 3xx si chiude con destroy(), senza leggerne il corpo", async () => {
    const destroyed: boolean[] = [];
    const r = await run("https://a.example/", [
      {
        status: 301,
        headers: { location: "/b" },
        body: "x".repeat(1000),
        onRes: (res) => {
          const orig = res.destroy.bind(res);
          res.destroy = ((e?: Error) => {
            destroyed.push(true);
            return orig(e);
          }) as typeof res.destroy;
          res.resume = (() => {
            throw new Error("resume non va usato");
          }) as typeof res.resume;
        },
      },
      { headers: html, body: "ok" },
    ]);
    expect(r).toMatchObject({ ok: true, redirects: 1 });
    expect(destroyed).toEqual([true]);
  });

  it("location relative e protocollo-relative, http rifiutato", async () => {
    const rel = await run("https://a.example/", [{ status: 302, headers: { location: "/it/" } }, { headers: html, body: "x" }]);
    expect(rel).toMatchObject({ ok: true, finalUrl: "https://a.example/it/" });
    const proto = await run("https://a.example/", [{ status: 302, headers: { location: "//b.example/x" } }, { headers: html, body: "x" }]);
    expect(proto).toMatchObject({ ok: true, finalUrl: "https://b.example/x" });
    const http = await run("https://a.example/", [{ status: 302, headers: { location: "http://a.example/" } }]);
    expect(http).toEqual({ ok: false, code: "not_allowed" });
  });

  it("redirect verso host che risolve a indirizzo privato → not_allowed", async () => {
    for (const addr of ["10.0.0.5", "::ffff:10.0.0.1"]) {
      const r = await run("https://a.example/", [{ status: 302, headers: { location: "https://evil.example/" } }, { headers: html, body: "x" }], {
        "evil.example": [addr],
      });
      expect(r, addr).toEqual({ ok: false, code: "not_allowed" });
    }
  });

  it("stato e tipi", async () => {
    expect(await run("https://a.example/", [{ status: 404 }])).toEqual({ ok: false, code: "http_status", status: 404 });
    expect(await run("https://a.example/", [{ headers: { "content-type": "application/pdf" }, body: "x" }])).toEqual({ ok: false, code: "unsupported_type" });
    expect(await run("https://a.example/", [{ headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: "x" }])).toEqual({
      ok: false,
      code: "unsupported_type",
    });
    expect(await run("https://a.example/", [{ headers: { "content-type": "application/ld+json" }, body: "{}" }])).toMatchObject({ ok: true, kind: "json" });
    expect(await run("https://a.example/", [{ headers: { "content-type": "text/markdown" }, body: "# a" }])).toMatchObject({ ok: true, kind: "text" });
    expect(await run("https://a.example/", [{ body: "<!doctype html><p>" }])).toMatchObject({ ok: true, kind: "html" });
    expect(await run("https://a.example/", [{ body: "ciao" }])).toMatchObject({ ok: true, kind: "text" });
  });

  it("corpo oltre il limite → troncato", async () => {
    const r = await run("https://a.example/", [{ headers: html, body: Buffer.alloc(WEB_MAX_BYTES + 10, 97) }]);
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && r.body.length).toBe(WEB_MAX_BYTES);
  });

  it("timeout e errore di rete", async () => {
    vi.useFakeTimers();
    const p = run("https://a.example/", [{ never: true }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ ok: false, code: "timeout" });
    vi.useRealTimers();
    expect(await run("https://a.example/", [{ error: true }])).toEqual({ ok: false, code: "unreachable" });
  });
});
