import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth legge la configurazione del login all'import (via routes/apps): senza variabili si importa con AUTH_DISABLED
vi.hoisted(() => {
  process.env["AUTH_DISABLED"] ??= "true";
});
import { characterInstructions } from "../instructions";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appToolsTable,
  appsTable,
  characterConversationsTable,
  characterProposalsTable,
  pendingActionsTable,
  runsTable,
  teamInstancesTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { encryptSecret } from "../../secrets";
import { allowTestLoopback, startFakeProvider } from "../../../../test/fake-provider";
import { enqueueAction } from "../../actions/queue";
import { queueTestProposal } from "../../../../test/proposal-fixture";
import { createTurnContext } from "../proposals";
import { startCharacterTurn } from "../run-turn";
import { CHARACTER_MESSAGES, type TurnContext } from "../types";
import { findSubject } from "../registry";
import { ALFRED_THREAD_TOOLS, getAlfredThread, restartAlfredThread } from "./alfred-thread";
import "./index";

// Il turno del capo non serve: si verifica solo l'accodamento del messaggio
vi.mock("../../teams/turn-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../teams/turn-runner")>()),
  sendToLead: vi.fn(async () => {}),
}));

// Nei test la richiesta al Responsabile non attende l'esito (25 s)
vi.mock("../../product-leads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../product-leads")>();
  return { ...actual, askProductLead: (u: number, a: Parameters<typeof actual.askProductLead>[1], o?: object) => actual.askProductLead(u, a, { ...o, waitMs: 0 }) };
});

const saved = process.env["CASELLO_SECRET_KEY"];
process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);

let userId: number;
let otherId: number;
let appId: number;
let modelId: number;

const handler = () => findSubject("alfred_thread")!;
const call = (ctx: TurnContext, name: string, args: unknown) => handler().runTool({ id: "c", name, arguments: JSON.stringify(args) }, ctx).then((s) => JSON.parse(s));

async function newCtx(uid = userId, page?: TurnContext["page"]): Promise<TurnContext> {
  const conv = await getAlfredThread(uid);
  const { characterMessagesTable } = await import("@workspace/db");
  const [m] = await db.insert(characterMessagesTable).values({ conversationId: conv.id, role: "assistant", content: "" }).returning();
  return createTurnContext({ userId: uid, conversationId: conv.id, messageId: m!.id, subjectId: null, ...(page ? { page } : {}) });
}

async function makeTeam(name: string, owner: number) {
  const [t] = await db
    .insert(teamInstancesTable)
    .values({ name, refAppId: appId, refType: "wi", refId: "1", refTitle: "Lavoro", status: "active", activatedBy: owner })
    .returning();
  return t!;
}

beforeEach(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [a] = await db.insert(usersTable).values({ email: "a@x.it", name: "A" }).returning();
  const [b] = await db.insert(usersTable).values({ email: "b@x.it", name: "B" }).returning();
  userId = a!.id;
  otherId = b!.id;
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" }).returning();
  appId = app!.id;
  const [acc] = await db.insert(aiAccountsTable).values({ userId, name: "Acc", provider: "custom", baseUrl: "http://x.example", apiKeyEnc: "x", status: "ok" }).returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: acc!.id, modelId: "m", displayName: "M" }).returning();
  modelId = model!.id;
  await db.update(usersTable).set({ alfredChatAiModelId: modelId }).where(eq(usersTable.id, userId));
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  if (saved === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved;
});

describe("filo di Alfred", () => {
  it("alfred_thread_get_or_create: lo crea con il modello di Alfred e lo riusa", async () => {
    const first = await getAlfredThread(userId);
    expect(first).toMatchObject({ character: "alfred", subjectType: "alfred_thread", subjectId: null, aiModelId: modelId, archivedAt: null });
    expect((await getAlfredThread(userId)).id).toBe(first.id);
  });

  it("alfred_thread_concurrent_get: due richieste insieme, stesso filo", async () => {
    const [a, b] = await Promise.all([getAlfredThread(userId), getAlfredThread(userId)]);
    expect(a.id).toBe(b.id);
    const rows = await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("restart_archives_old: archivia il filo aperto e ne apre uno nuovo; l'archiviato è in sola lettura", async () => {
    const old = await getAlfredThread(userId);
    const fresh = await restartAlfredThread(userId);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.archivedAt).toBeNull();
    const [archived] = await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, old.id));
    expect(archived!.archivedAt).not.toBeNull();
    await expect(startCharacterTurn(old.id, "Ciao", null)).rejects.toMatchObject({ status: 409, message: CHARACTER_MESSAGES.archived });
  });

  it("context_lists_teams_and_counts: una riga per squadra, conteggi, riga della pagina", async () => {
    const team = await makeTeam("Alfa", userId);
    await makeTeam("Beta", userId);
    await makeTeam("Altrui", otherId);
    await db.insert(pendingActionsTable).values({ userId, number: 1, kind: "plan", teamInstanceId: team.id, argsEnc: "x", argsPublic: {}, recipient: "r", summary: "Piano" });
    const [text] = await handler().context(userId, null, { page: "team", id: String(team.id) });
    expect(text).toContain("Squadre attive: 2.");
    expect(text).toContain(`#${team.id} Alfa`);
    expect(text).toContain("Beta");
    expect(text).not.toContain("Altrui");
    expect(text).toContain("Voci da confermare: 1.");
    expect(text).toContain("Eventi non letti nel bollettino: 0.");
    expect(text).toContain("Pagina: squadra Alfa");
    const [noPage] = await handler().context(userId, null, null);
    expect(noPage).not.toContain("Pagina:");
  });

  it("context_no_model_calls: 6 squadre attive, tutte elencate e nessuna chiamata al provider", async () => {
    const fake = await startFakeProvider({ apiKey: "sk-X" });
    const restore = allowTestLoopback();
    try {
      const [acc] = await db.insert(aiAccountsTable).values({ userId, name: "F", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-X"), status: "ok" }).returning();
      const [m] = await db.insert(aiModelsTable).values({ accountId: acc!.id, modelId: "fake-model", displayName: "F" }).returning();
      await db.update(usersTable).set({ centralinoAiModelId: m!.id }).where(eq(usersTable.id, userId));
      for (let i = 1; i <= 6; i++) await makeTeam(`Squadra${i}`, userId);
      const [text] = await handler().context(userId, null, null);
      for (let i = 1; i <= 6; i++) expect(text).toContain(`Squadra${i} · Lavoro`);
      expect(text).toContain("Squadre attive: 6.");
      expect(fake.requests).toHaveLength(0);
    } finally {
      restore();
      await fake.close();
    }
  });

  it("squadre_stato_no_model_calls: 6 squadre attive, 6 righe e nessuna richiesta al provider", async () => {
    const fake = await startFakeProvider({ apiKey: "sk-X" });
    const restore = allowTestLoopback();
    try {
      const [acc] = await db.insert(aiAccountsTable).values({ userId, name: "F", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-X"), status: "ok" }).returning();
      const [m] = await db.insert(aiModelsTable).values({ accountId: acc!.id, modelId: "fake-model", displayName: "F" }).returning();
      await db.update(usersTable).set({ centralinoAiModelId: m!.id }).where(eq(usersTable.id, userId));
      for (let i = 1; i <= 6; i++) await makeTeam(`Squadra${i}`, userId);
      const out = await call(await newCtx(), "squadre_stato", {});
      expect(out.ok).toBe(true);
      expect(out.result).toMatchObject({ summarized: false, teams: 6 });
      expect(out.result.lines).toHaveLength(6);
      expect(fake.requests).toHaveLength(0);
    } finally {
      restore();
      await fake.close();
    }
  });

  it("leggi_run_own_only: solo le run dell'utente", async () => {
    const [agent] = await db.insert(agentsTable).values({ appId, name: "Gen", role: "general" }).returning();
    const [mine] = await db.insert(runsTable).values({ agentId: agent!.id, aiModelId: modelId, status: "failed", input: "SEGRETO-INPUT", errorMessage: "Errore durante l'esecuzione: boom", durationMs: 1200 }).returning();
    const [otherAcc] = await db.insert(aiAccountsTable).values({ userId: otherId, name: "B", provider: "custom", baseUrl: "http://y.example", apiKeyEnc: "x", status: "ok" }).returning();
    const [otherModel] = await db.insert(aiModelsTable).values({ accountId: otherAcc!.id, modelId: "m2", displayName: "M2" }).returning();
    const [theirs] = await db.insert(runsTable).values({ agentId: agent!.id, aiModelId: otherModel!.id, status: "succeeded", output: "ok" }).returning();
    const ctx = await newCtx();
    const own = await call(ctx, "leggi_run", { id: mine!.id });
    expect(own).toMatchObject({ ok: true, result: { id: mine!.id, status: "failed", error: "Errore durante l'esecuzione: boom", durationMs: 1200 } });
    expect(JSON.stringify(own)).not.toContain("SEGRETO-INPUT");
    expect(await call(ctx, "leggi_run", { id: theirs!.id })).toEqual({ ok: false, error: "run non trovata" });
    expect(await call(ctx, "leggi_run", { id: 99999 })).toEqual({ ok: false, error: "run non trovata" });
    expect(own.result.voci).toEqual([]);
  });

  it("chiedi_al_responsabile: senza app usa quella della pagina ospite; app troppo lunga → argomenti non validi", async () => {
    const [hub] = await db.insert(appsTable).values({ name: "Hub", slug: "hubup", baseUrl: "http://hub.example" }).returning();
    const [lead] = await db.insert(agentsTable).values({ appId: hub!.id, name: "Resp", role: "general", status: "active", aiModelId: modelId }).returning();
    const ctx = await newCtx(userId, { page: "host", host: { app: "hubup", page: "x" } });
    const out = await call(ctx, "chiedi_al_responsabile", { richiesta: "Fai il punto" });
    expect(out.ok).toBe(true);
    const runs = await db.select().from(runsTable).where(eq(runsTable.agentId, lead!.id));
    expect(runs).toHaveLength(1);
    expect(await call(ctx, "chiedi_al_responsabile", { richiesta: "x", app: "a".repeat(101) })).toEqual({ ok: false, error: "argomenti non validi" });
  });

  it("elenca_app: App con Responsabile dell'utente", async () => {
    const [hub] = await db.insert(appsTable).values({ name: "Hub", slug: "hubup", baseUrl: "http://hub.example" }).returning();
    await db.insert(agentsTable).values({ appId: hub!.id, name: "Resp", role: "general", status: "active", aiModelId: modelId });
    const out = await call(await newCtx(), "elenca_app", {});
    expect(out.result.map((a: { app: string }) => a.app)).toEqual(["hubup"]);
  });
});

describe("proponi_decisione", () => {
  it("proponi_decisione_records_card: scheda con sintesi, payload e hash", async () => {
    const team = await makeTeam("Alfa", userId);
    await db.insert(pendingActionsTable).values({ userId, number: 7, kind: "plan", teamInstanceId: team.id, argsEnc: "x", argsPublic: {}, recipient: "r", summary: "Piano da approvare" });
    const ctx = await newCtx();
    const out = await call(ctx, "proponi_decisione", { numero: 7, decisione: "rifiuta", nota: "Troppo vago" });
    expect(out.ok).toBe(true);
    const [card] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.messageId, ctx.messageId));
    expect(card).toMatchObject({ kind: "decision", status: "pending", rationale: "" });
    expect(card!.payload).toEqual({ number: 7, decision: "rifiuta", note: "Troppo vago", kind: "plan", teamName: "Alfa", summary: "Piano da approvare", needsUserToken: false, exclude: null });
    const { createHash } = await import("node:crypto");
    expect(card!.targetHash).toBe(createHash("sha256").update("pending\nPiano da approvare").digest("hex"));
    // Voce inesistente
    expect((await call(ctx, "proponi_decisione", { numero: 8, decisione: "approva" })).ok).toBe(false);
  });

  it("proponi_decisione_needs_user_token: needsUserToken nel payload", async () => {
    const [tool] = await db
      .insert(appToolsTable)
      .values({ appId, name: "set_password", kind: "http", identity: "user", level: "L2", status: "active", paramsSchema: { type: "object", properties: {} }, definition: { method: "POST", path: "/x", paramLocations: {} } } as InsertAppTool)
      .returning();
    const queued = await enqueueAction({
      userId,
      appId,
      agentId: null,
      runId: null,
      tool: { ...tool!, paramsSchema: { type: "object", properties: {} }, definition: tool!.definition as never },
      args: {},
      recipient: "Rosa",
      summary: "Cambia la password",
    });
    expect(queued.ok).toBe(true);
    const ctx = await newCtx();
    const out = await call(ctx, "proponi_decisione", { numero: 1, decisione: "approva" });
    expect(out.ok).toBe(true);
    const [card] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.messageId, ctx.messageId));
    expect(card!.payload).toMatchObject({ number: 1, kind: "action", needsUserToken: true, teamName: null });
  });

  it("nota_only_with_reject: nota con approva → errore, nessuna scheda", async () => {
    const team = await makeTeam("Alfa", userId);
    await db.insert(pendingActionsTable).values({ userId, number: 1, kind: "plan", teamInstanceId: team.id, argsEnc: "x", argsPublic: {}, recipient: "r", summary: "S" });
    const ctx = await newCtx();
    const out = await call(ctx, "proponi_decisione", { numero: 1, decisione: "approva", nota: "x" });
    expect(out).toEqual({ ok: false, error: "la nota si usa solo con il rifiuto" });
    expect(await db.select().from(characterProposalsTable)).toHaveLength(0);
  });
});

describe("scrivi_al_capo", () => {
  it("scrivi_al_capo_rate_limit: l'11° messaggio nel minuto è rifiutato", async () => {
    const ctx = await newCtx();
    // Il contatore è in memoria e per utente: si usa un utente nuovo con la sua squadra
    const [u] = await db.insert(usersTable).values({ email: "c@x.it" }).returning();
    const own = await makeTeam("Gamma", u!.id);
    const ctx2 = createTurnContext({ ...ctx, userId: u!.id });
    for (let i = 0; i < 10; i++) expect(await call(ctx2, "scrivi_al_capo", { id: own.id, testo: `m${i}` })).toEqual({ ok: true, result: { queued: true } });
    expect(await call(ctx2, "scrivi_al_capo", { id: own.id, testo: "undicesimo" })).toEqual({ ok: false, error: "Troppe richieste: riprova tra poco" });
    // Squadra altrui
    expect((await call(ctx, "scrivi_al_capo", { id: (await makeTeam("Z", otherId)).id, testo: "x" })).ok).toBe(false);
  });

  it("gli strumenti sono quelli attesi, senza prepara/conferma", () => {
    expect(ALFRED_THREAD_TOOLS.map((t) => t.function.name)).toEqual([
      "squadre_stato", "squadra_dettaglio", "bollettino", "coda_da_confermare", "leggi_proposta", "scrivi_al_capo", "elenca_app", "chiedi_al_responsabile", "leggi_run", "proponi_decisione",
    ]);
  });
});

describe("proposte multiple nella chat", () => {
  async function proposalTool() {
    const [tool] = await db
      .insert(appToolsTable)
      .values({ appId, name: "crea", kind: "mcp", identity: "service", level: "L2", status: "active", paramsSchema: { type: "object", properties: {} }, definition: { mcpName: "crea" } } as InsertAppTool)
      .returning();
    return queueTestProposal({ userId, appId, toolId: tool!.id, toolName: "crea" });
  }

  it("coda_da_confermare e leggi_proposta: numero di passi e passi da leggere", async () => {
    const n = await proposalTool();
    const ctx = await newCtx();
    const queue = await call(ctx, "coda_da_confermare", {});
    expect(queue.result.actions[0]).toMatchObject({ numero: n, tipo: "proposal", sintesi: "Nuovo progetto", passi: 3 });
    const read = await call(ctx, "leggi_proposta", { numero: n });
    expect(read).toMatchObject({ ok: true, result: { numero: n, titolo: "Nuovo progetto", motivo: "Richiesta del cliente", stato: "pending" } });
    expect(read.result.passi.map((p: { passo: string; numero: number }) => `${p.passo}:${p.numero}`)).toEqual(["p1:1", "p2:2", "p3:3"]);
    expect(await call(ctx, "leggi_proposta", { numero: 99 })).toEqual({ ok: false, error: "proposta non trovata" });
  });

  it("proponi_decisione con escludi: scheda con exclude normalizzato; errori senza scheda", async () => {
    const n = await proposalTool();
    const ctx = await newCtx();
    const out = await call(ctx, "proponi_decisione", { numero: n, decisione: "approva", escludi: [2] });
    expect(out).toMatchObject({ ok: true, result: { numero: n, passiEsclusi: ["p2"], passiSaltati: ["p3"] } });
    const [card] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.messageId, ctx.messageId));
    expect(card!.payload).toMatchObject({ number: n, decision: "approva", kind: "proposal", exclude: ["p2"] });

    const ctx2 = await newCtx();
    expect(await call(ctx2, "proponi_decisione", { numero: n, decisione: "rifiuta", escludi: ["p2"] })).toEqual({ ok: false, error: "i passi da escludere valgono solo con approva" });
    expect(await call(ctx2, "proponi_decisione", { numero: n, decisione: "approva", escludi: ["p7"] })).toEqual({ ok: false, error: "passi da escludere non validi" });
    expect(await call(ctx2, "proponi_decisione", { numero: n, decisione: "approva", escludi: ["p1", "p2"] })).toEqual({ ok: false, error: "nessun passo da eseguire: rifiuta la proposta" });
    const [plan] = await db.insert(pendingActionsTable).values({ userId, number: 50, kind: "plan", argsEnc: "x", argsPublic: {}, recipient: "r", summary: "Piano" }).returning();
    expect(await call(ctx2, "proponi_decisione", { numero: plan!.number, decisione: "approva", escludi: [1] })).toEqual({ ok: false, error: "passi da escludere non validi" });
    expect(await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.messageId, ctx2.messageId))).toHaveLength(0);
  });
});

describe("istruzioni di Alfred scritto", () => {
  it("istruzioni_responsabili: spiega quando chiamare i Responsabili", () => {
    const t = characterInstructions("alfred");
    expect(t).toContain("chiedi_al_responsabile");
    expect(t).toContain("una chiamata per App");
    expect(t).toContain("Ogni Responsabile agisce solo sulla sua App");
  });
});
