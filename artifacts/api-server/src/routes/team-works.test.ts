import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, teamWorksTable } from "@workspace/db";
import { ensureUser, nodeRole, seedNodeTeam } from "../../test/team-node-fixture";

// Lavori su branch unico sulle route: elenco e `work` nella vista del PLAN (app completa, senza login)

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let instanceId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

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
  const userId = await ensureUser("dev@localhost");
  instanceId = await seedNodeTeam({ userId, roles: [nodeRole({ key: "dev", runsOn: "cloud", code: "write" } as never)], tasks: { t1: "dev" } });
});

describe("lavori della squadra", () => {
  it("senza lavori: elenco vuoto e work null nel PLAN", async () => {
    expect(await json(await fetch(`${base}/api/team-instances/${instanceId}/works`))).toEqual([]);
    const plan = await json(await fetch(`${base}/api/team-instances/${instanceId}/plan`));
    expect(plan.work).toBeNull();
  });

  it("con un lavoro aperto: elenco e work nel PLAN", async () => {
    await db.insert(teamWorksTable).values({ instanceId, number: 1, repo: "o/r", branch: `botcave/lavoro-${instanceId}-1`, baseBranch: "main", baseSha: "a".repeat(40) });
    const rows = await json(await fetch(`${base}/api/team-instances/${instanceId}/works`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 1, status: "open", branch: `botcave/lavoro-${instanceId}-1`, mergedPulls: 0, releaseActionNumber: null });
    const plan = await json(await fetch(`${base}/api/team-instances/${instanceId}/plan`));
    expect(plan.work).toMatchObject({ number: 1, status: "open" });
  });

  it("voce «Porta in produzione» nell'elenco di «Da confermare»", async () => {
    const { pendingActionsTable, usersTable } = await import("@workspace/db");
    const [u] = await db.select().from(usersTable);
    await db.insert(pendingActionsTable).values({ userId: u!.id, number: 1, kind: "release", recipient: "o/r", summary: "Porta in produzione il lavoro 1", argsEnc: "x", argsPublic: { number: 1 }, teamInstanceId: instanceId } as never);
    const res = await fetch(`${base}/api/pending-actions`);
    expect(res.status).toBe(200);
    const rows = await json(res);
    expect(rows.actions.map((r: { kind: string }) => r.kind)).toEqual(["release"]);
  });

  it("squadra inesistente: 404", async () => {
    expect((await fetch(`${base}/api/team-instances/999/works`)).status).toBe(404);
  });
});
