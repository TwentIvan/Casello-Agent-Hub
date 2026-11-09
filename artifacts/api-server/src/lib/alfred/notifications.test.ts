import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, agentsTable, appsTable, pendingActionsTable, runsTable, teamInstancesTable, usersTable } from "@workspace/db";
import { LEAD_INPUT_MARKER } from "../product-leads";
import { NOTIFICATIONS_MAX, NOTIFICATION_TEXT_MAX, alfredNotifications } from "./notifications";
import { AlfredError } from "./gemini";

// Novità di Alfred: run dei Responsabili finite e nuove voci in coda, con cursore.

const T0 = new Date("2026-11-09T10:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const LEAD_INPUT = `Richiesta ${LEAD_INPUT_MARKER}\n<richiesta>x</richiesta>`;

let seq = 0;
let me: { userId: number; modelId: number };
let other: { userId: number; modelId: number };
let leadId: number;
let areaId: number;
let appId: number;
let number = 0;

async function seedUser(name: string) {
  const [user] = await db.insert(usersTable).values({ email: `n${++seq}@example.com`, name }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: user!.id, name: `Account ${name}`, provider: "custom", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnc: "x", status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  return { userId: user!.id, modelId: model!.id };
}

beforeEach(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  number = 0;
  me = await seedUser("Io");
  other = await seedUser("Altro");
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example", userAuth: { header: "authorization", scheme: "Bearer" } })
    .returning();
  appId = app!.id;
  const [lead] = await db.insert(agentsTable).values({ appId, name: "Resp", role: "general", status: "active", aiModelId: me.modelId }).returning();
  const [area] = await db.insert(agentsTable).values({ appId, name: "Area", role: "area", status: "active", aiModelId: me.modelId }).returning();
  leadId = lead!.id;
  areaId = area!.id;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

async function run(opts: { agentId?: number; modelId?: number; input?: string; status?: "succeeded" | "failed" | "running"; finishedAt?: Date | null; output?: string | null; error?: string | null }) {
  const status = opts.status ?? "succeeded";
  const [r] = await db
    .insert(runsTable)
    .values({
      agentId: opts.agentId ?? leadId,
      aiModelId: opts.modelId ?? me.modelId,
      input: opts.input ?? LEAD_INPUT,
      status,
      output: opts.output ?? "Fatto",
      errorMessage: opts.error ?? null,
      finishedAt: opts.finishedAt === undefined ? (status === "running" ? null : at(30)) : opts.finishedAt,
    })
    .returning();
  return r!;
}

async function item(opts: { userId?: number; runId?: number | null; status?: "pending" | "rejected"; createdAt?: Date; teamId?: number | null; summary?: string }) {
  const [r] = await db
    .insert(pendingActionsTable)
    .values({
      userId: opts.userId ?? me.userId,
      number: ++number,
      kind: "proposal",
      appId,
      runId: opts.runId ?? null,
      teamInstanceId: opts.teamId ?? null,
      argsEnc: "x",
      argsPublic: {},
      recipient: "Mister",
      summary: opts.summary ?? `Voce ${number}`,
      status: opts.status ?? "pending",
      createdAt: opts.createdAt ?? at(30),
    })
    .returning();
  return r!;
}

const now = at(60);

describe("alfredNotifications", () => {
  it("senza cursore risponde solo con quello iniziale", async () => {
    await run({});
    expect(await alfredNotifications(me.userId, null, now)).toEqual({ cursor: now.toISOString(), events: [] });
  });

  it("cursore nel futuro → 400", async () => {
    await expect(alfredNotifications(me.userId, at(120), now)).rejects.toMatchObject({ status: 400 });
    await expect(alfredNotifications(me.userId, at(120), now)).rejects.toBeInstanceOf(AlfredError);
  });

  it("run del Responsabile finita: un evento con le sue voci, senza queue_item per le stesse", async () => {
    const r = await run({});
    await item({ runId: r.id });
    await item({ runId: r.id });
    const { events, cursor } = await alfredNotifications(me.userId, at(0), now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "lead_run", run: r.id, app: "Mister", status: "succeeded", output: "Fatto", error: null, at: at(30).toISOString() });
    expect(events[0]!.kind === "lead_run" && events[0]!.items.map((i) => i.numero)).toEqual([1, 2]);
    expect(cursor).toBe(at(30).toISOString());
  });

  it("voce in coda di una run di area o senza run: queue_item con il nome della squadra", async () => {
    const areaRun = await run({ agentId: areaId, input: "altro" });
    const [team] = await db
      .insert(teamInstancesTable)
      .values({ name: "Squadra Uno", refAppId: appId, refType: "wi", refId: "1", refTitle: "wi · 1", roles: [] })
      .returning();
    await item({ runId: areaRun.id, teamId: team!.id });
    await item({ runId: null });
    const { events } = await alfredNotifications(me.userId, at(0), now);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "queue_item", numero: 1, tipo: "proposal", squadra: "Squadra Uno", sintesi: "Voce 1" });
    expect(events[1]).toMatchObject({ kind: "queue_item", numero: 2, squadra: null });
  });

  it("esclude run altrui, senza marcatore, in corso, voci altrui o decise, tempi fuori finestra", async () => {
    await run({ modelId: other.modelId });
    await run({ input: "niente marcatore" });
    await run({ status: "running" });
    await run({ finishedAt: at(0) }); // ≤ after
    await run({ finishedAt: at(61) }); // > now
    await item({ userId: other.userId });
    await item({ status: "rejected" });
    await item({ createdAt: at(0) });
    await item({ createdAt: at(61) });
    expect(await alfredNotifications(me.userId, at(0), now)).toEqual({ cursor: now.toISOString(), events: [] });
  });

  it("12 eventi: 10 in ordine di tempo, poi gli altri 2 con il cursore", async () => {
    for (let i = 1; i <= 12; i++) await item({ createdAt: at(i) });
    const first = await alfredNotifications(me.userId, at(0), now);
    expect(first.events).toHaveLength(NOTIFICATIONS_MAX);
    expect(first.events.map((e) => (e.kind === "queue_item" ? e.numero : 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.cursor).toBe(at(10).toISOString());
    const second = await alfredNotifications(me.userId, new Date(first.cursor), now);
    expect(second.events.map((e) => (e.kind === "queue_item" ? e.numero : 0))).toEqual([11, 12]);
    expect(second.cursor).toBe(at(12).toISOString());
  });

  it("un cursore più vecchio di un'ora considera solo l'ultima ora", async () => {
    await item({ createdAt: new Date(now.getTime() - 2 * 3_600_000) });
    await item({ createdAt: new Date(now.getTime() - 1_800_000) });
    const { events } = await alfredNotifications(me.userId, new Date(now.getTime() - 5 * 3_600_000), now);
    expect(events.map((e) => (e.kind === "queue_item" ? e.numero : 0))).toEqual([2]);
  });

  it("taglia l'esito a 300 caratteri", async () => {
    await run({ output: "x".repeat(500) });
    const { events } = await alfredNotifications(me.userId, at(0), now);
    expect(events[0]!.kind === "lead_run" && events[0]!.output).toHaveLength(NOTIFICATION_TEXT_MAX);
  });
});
