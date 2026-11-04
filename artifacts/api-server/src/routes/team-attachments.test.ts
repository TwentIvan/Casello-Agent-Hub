import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { ensureUser, nodeRole, seedNodeTeam } from "../../test/team-node-fixture";

// Allegati delle squadre e spazio di lavoro sulle route (app completa, senza login)

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let instanceId: number;
let userId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

const upload = (id: number, name: string | undefined, body: Buffer | string, contentType = "text/plain") =>
  fetch(`${base}/api/team-instances/${id}/attachments`, {
    method: "POST",
    headers: { "content-type": contentType, ...(name === undefined ? {} : { "x-attachment-name": name }) },
    body,
  });

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost", CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  await fetch(`${base}/api/auth/me`);
  userId = await ensureUser("dev@localhost");
  instanceId = await seedNodeTeam({ userId, roles: [nodeRole()] });
});

describe("allegati", () => {
  it("carica, elenca, scarica (solo come download) ed elimina", async () => {
    const res = await upload(instanceId, encodeURIComponent("relazione è.html"), "<script>alert(1)</script>", "text/html; charset=utf-8");
    expect(res.status, await res.clone().text()).toBe(201);
    const view = await json(res);
    expect(view).toMatchObject({ name: "relazione è.html", contentType: "text/html", sizeBytes: 25 });
    expect(view.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await json(await fetch(`${base}/api/team-instances/${instanceId}/attachments`));
    expect(list.map((a: { id: number }) => a.id)).toEqual([view.id]);

    const dl = await fetch(`${base}/api/team-instances/${instanceId}/attachments/${view.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("text/html");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await dl.text()).toBe("<script>alert(1)</script>");

    expect((await fetch(`${base}/api/team-instances/${instanceId}/attachments/${view.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/api/team-instances/${instanceId}/attachments/${view.id}`)).status).toBe(404);
    expect(await json(await fetch(`${base}/api/team-instances/${instanceId}/attachments`))).toEqual([]);
  });

  it("un file JSON viene salvato com'è (il parser JSON globale non lo tocca, anche oltre 100 kB)", async () => {
    const body = JSON.stringify({ dati: "x".repeat(300_000) });
    const res = await upload(instanceId, "dati.json", body, "application/json");
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await json(res)).sizeBytes).toBe(Buffer.byteLength(body));
  });

  it("oltre 10 MB → 413 «allegato troppo grande»; nome mancante o non valido → 400; squadra chiusa → 409; squadra inesistente → 404", async () => {
    const big = await upload(instanceId, "g.bin", Buffer.alloc(10 * 1024 * 1024 + 1), "application/octet-stream");
    expect(big.status).toBe(413);
    expect((await json(big)).error).toBe("allegato troppo grande");
    expect((await upload(instanceId, undefined, "x")).status).toBe(400);
    const bad = await upload(instanceId, encodeURIComponent("../x"), "x");
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("allegato non valido");
    expect((await upload(99999, "a.txt", "x")).status).toBe(404);
    await pool.query("UPDATE team_instances SET status = 'closed' WHERE id = $1", [instanceId]);
    const closed = await upload(instanceId, "a.txt", "x");
    expect(closed.status).toBe(409);
    expect((await json(closed)).error).toBe("squadra chiusa");
  });
});

describe("spazio di lavoro", () => {
  const save = async (extra: Record<string, unknown>) => {
    return fetch(`${base}/api/team-instances/${instanceId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Squadra WI", roles: [nodeRole({ key: "capo", name: "Capo", isLead: true })], localSkills: [], ...extra }),
    });
  };

  it("PUT imposta nodeWorkspace; valori non validi → 400 con il messaggio fisso", async () => {
    for (const bad of ["../x", "/abs", "a/../b"]) {
      const res = await save({ nodeWorkspace: bad });
      expect(res.status, bad).toBe(400);
      expect((await json(res)).error).toBe("spazio di lavoro non valido");
    }
    const ok = await save({ nodeWorkspace: "SAP/AIMAG/CR/DS5100/WI_1174" });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await json(ok)).nodeWorkspace).toBe("SAP/AIMAG/CR/DS5100/WI_1174");
    expect((await json(await fetch(`${base}/api/team-instances/${instanceId}`))).nodeWorkspace).toBe("SAP/AIMAG/CR/DS5100/WI_1174");
    expect((await json(await save({ nodeWorkspace: null }))).nodeWorkspace).toBeNull();
  });
});
