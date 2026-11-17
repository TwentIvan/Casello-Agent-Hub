import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  bugReportsTable,
  githubInstallationsTable,
  pendingActionsTable,
  teamInstancesTable,
  teamTurnsTable,
  usersTable,
  type BugReportRow,
} from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { approveAction, failInterruptedActions, rejectAction } from "../actions/decide";
import { clearInstallationTokenCache } from "../github/app";
import { resetGithubConfigForTests } from "../github/config";
import { logger } from "../logger";
import { encryptSecret } from "../secrets";
import { bugIssueBody, bugTeamRequest, designatedBugTeam, ensureApprovalItem, noMentions } from "./approval";
import { BUG_MESSAGES } from "./messages";
import { sweepBugsOnce } from "./sweeper";

// Voce «Bug» in «Da confermare»: creazione, approvazione (issue, turno del capo) e rifiuto. PGlite + finto GitHub.

const REPO = "ivan/thu";
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
const savedKey = process.env["CASELLO_SECRET_KEY"];

let gh: FakeGithub;
let ownerId: number;
let activatorId: number;
let appId: number;
let leadId: number;
let teamId: number;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  resetGithubConfigForTests();
});

afterAll(async () => {
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, team_instances, users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.issues.clear();
  gh.labels.clear();
  gh.installationPermissions.clear();
  gh.failWith = null;
  gh.requests.length = 0;
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);

  await pool.query("TRUNCATE apps, ai_accounts, github_installations, team_instances, users RESTART IDENTITY CASCADE");
  const [owner] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  const [activator] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Capo" }).returning();
  ownerId = owner!.id;
  activatorId = activator!.id;
  await db.insert(githubInstallationsTable).values({ userId: ownerId, installationId: 7, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: ownerId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  const [app] = await db
    .insert(appsTable)
    .values({ name: "The Hub Up", slug: "thu", baseUrl: "https://thu.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7 })
    .returning();
  appId = app!.id;
  const [lead] = await db
    .insert(agentsTable)
    .values({ appId, name: "Responsabile", role: "general", status: "active", aiModelId: model!.id })
    .returning();
  leadId = lead!.id;
  const [team] = await db
    .insert(teamInstancesTable)
    .values({
      name: "Squadra bug",
      refAppId: appId,
      refType: "bug",
      refId: "thu",
      refTitle: "Bug di THU",
      status: "active",
      roles: [],
      createdBy: activatorId,
      activatedBy: activatorId,
      bugTeam: true,
    })
    .returning();
  teamId = team!.id;
});

async function seedReport(over: Partial<typeof bugReportsTable.$inferInsert> = {}): Promise<BugReportRow> {
  const [row] = await db
    .insert(bugReportsTable)
    .values({
      appId,
      number: 4,
      reporterKind: "identity",
      reporterSub: "sub-segreto-42",
      reporterName: "Mario",
      reporterEmail: "mario@example.com",
      title: "Il salvataggio non va",
      description: "Premo Salva e non succede nulla",
      steps: "1. apri il work item\n2. premi Salva",
      expected: "Il work item salvato",
      pageContext: { page: "work-item", id: "12", url: "https://thu.example/wi/12" },
      status: "pending_approval",
      triage: { verdict: "bug", summary: "Il pulsante Salva non manda la richiesta.", runId: 1 },
      ...over,
    })
    .returning();
  return row!;
}

const getReport = async (id: number) => (await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, id)))[0]!;
const items = () => db.select().from(pendingActionsTable);
const reasons = async () => (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, teamId))).flatMap((t) => t.reasons);
const issueCalls = () => gh.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"));

async function queued(report: BugReportRow) {
  await ensureApprovalItem(report.id);
  const r = await getReport(report.id);
  const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, r.pendingActionId!));
  return item!;
}

describe("ensureApprovalItem", () => {
  it("crea la voce bug per il proprietario del modello del Responsabile, una volta sola", async () => {
    const report = await seedReport();
    await ensureApprovalItem(report.id);
    await ensureApprovalItem(report.id);
    const all = await items();
    expect(all).toHaveLength(1);
    const item = all[0]!;
    expect(item).toMatchObject({
      kind: "bug",
      userId: ownerId,
      appId,
      toolId: null,
      status: "pending",
      recipient: "The Hub Up",
      summary: "Bug n. 4: Il salvataggio non va",
    });
    expect(item.argsPublic).toEqual({
      reportId: report.id,
      number: 4,
      title: "Il salvataggio non va",
      description: "Premo Salva e non succede nulla",
      steps: "1. apri il work item\n2. premi Salva",
      expected: "Il work item salvato",
      triage: { verdict: "bug", summary: "Il pulsante Salva non manda la richiesta.", runId: 1 },
      team: { id: teamId, name: "Squadra bug" },
    });
    expect((await getReport(report.id)).pendingActionId).toBe(item.id);
  });

  it("senza modello del Responsabile la voce va a chi ha attivato la squadra designata", async () => {
    await db.update(agentsTable).set({ aiModelId: null }).where(eq(agentsTable.id, leadId));
    const report = await seedReport();
    const item = await queued(report);
    expect(item.userId).toBe(activatorId);
  });

  it("senza nessuno che possa approvare la segnalazione resta senza voce", async () => {
    await db.update(agentsTable).set({ aiModelId: null }).where(eq(agentsTable.id, leadId));
    await db.update(teamInstancesTable).set({ bugTeam: false }).where(eq(teamInstancesTable.id, teamId));
    const report = await seedReport();
    await ensureApprovalItem(report.id);
    expect(await items()).toHaveLength(0);
    expect((await getReport(report.id)).pendingActionId).toBeNull();
  });

  it("non crea voci per segnalazioni non in attesa di approvazione", async () => {
    const report = await seedReport({ status: "triage" });
    await ensureApprovalItem(report.id);
    expect(await items()).toHaveLength(0);
  });

  it("designatedBugTeam ignora le squadre chiuse", async () => {
    expect(await designatedBugTeam(appId)).toMatchObject({ id: teamId, name: "Squadra bug", status: "active", activatedBy: activatorId });
    await db.update(teamInstancesTable).set({ status: "closed" }).where(eq(teamInstancesTable.id, teamId));
    expect(await designatedBugTeam(appId)).toBeNull();
  });
});

describe("approvazione", () => {
  it("senza squadra attiva: 409 e voce ancora pending", async () => {
    const report = await seedReport();
    const item = await queued(report);
    await db.update(teamInstancesTable).set({ status: "draft" }).where(eq(teamInstancesTable.id, teamId));
    const res = await approveAction(ownerId, item.number);
    expect(res).toEqual({ ok: false, status: 409, message: BUG_MESSAGES.noBugTeam });
    expect((await db.select().from(pendingActionsTable))[0]!.status).toBe("pending");
    expect((await getReport(report.id)).status).toBe("pending_approval");
    expect(issueCalls()).toHaveLength(0);
  });

  it("con la squadra attiva: issue con etichette, segnalazione in lavorazione, turno request con la issue", async () => {
    const report = await seedReport();
    const item = await queued(report);
    const res = await approveAction(ownerId, item.number);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action).toMatchObject({ status: "done", result: "Affidata alla squadra Squadra bug" });

    const issues = gh.issues.get(REPO) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toEqual(expect.arrayContaining(["bug", "botcave"]));
    expect(issues[0]!.body).not.toContain("sub-segreto-42");
    expect(issues[0]!.body).not.toContain("mario@example.com");

    const after = await getReport(report.id);
    expect(after).toMatchObject({ status: "in_progress", teamInstanceId: teamId, issueNumber: issues[0]!.number });
    expect(after.issueUrl).toContain(String(issues[0]!.number));

    const rs = await reasons();
    expect(rs).toHaveLength(1);
    expect(rs[0]!.type).toBe("request");
    expect((rs[0] as { text: string }).text).toContain(`#${issues[0]!.number}`);
  });

  it("chi approva senza l'installazione: nessuna issue, segnalazione comunque in lavorazione", async () => {
    await db.delete(githubInstallationsTable);
    const report = await seedReport();
    const item = await queued(report);
    const res = await approveAction(ownerId, item.number);
    expect(res.ok && res.action.status).toBe("done");
    expect(issueCalls()).toHaveLength(0);
    expect(await getReport(report.id)).toMatchObject({ status: "in_progress", issueNumber: null, teamInstanceId: teamId });
    expect(await reasons()).toHaveLength(1);
  });

  it("GitHub in errore: nessuna issue, segnalazione comunque in lavorazione", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    gh.failWith = () => 500;
    const report = await seedReport();
    const item = await queued(report);
    const res = await approveAction(ownerId, item.number);
    expect(res.ok && res.action.status).toBe("done");
    expect(await getReport(report.id)).toMatchObject({ status: "in_progress", issueNumber: null });
    expect(await reasons()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("approvazione interrotta (voce executing → failed all'avvio): lo sweeper crea una voce nuova, una volta sola", async () => {
    const report = await seedReport();
    const item = await queued(report);
    // Prenotata e mai conclusa: il processo è caduto tra le due transazioni
    await db.update(pendingActionsTable).set({ status: "executing" }).where(eq(pendingActionsTable.id, item.id));
    expect(await failInterruptedActions()).toBe(1);

    await sweepBugsOnce();
    await sweepBugsOnce();
    const all = await items();
    expect(all.map((i) => i.status).sort()).toEqual(["failed", "pending"]);
    const fresh = all.find((i) => i.status === "pending")!;
    expect(fresh).toMatchObject({ kind: "bug", userId: ownerId });
    expect(await getReport(report.id)).toMatchObject({ status: "pending_approval", pendingActionId: fresh.id });

    // La voce nuova si approva come le altre
    const res = await approveAction(ownerId, fresh.number);
    expect(res.ok && res.action.status).toBe("done");
    expect((await getReport(report.id)).status).toBe("in_progress");
  });

  it("lo sweeper non tocca le voci ancora aperte", async () => {
    const report = await seedReport();
    const item = await queued(report);
    await sweepBugsOnce();
    expect(await items()).toHaveLength(1);
    expect((await getReport(report.id)).pendingActionId).toBe(item.id);
  });

  it("due approvazioni concorrenti: una sola issue e un solo turno", async () => {
    const report = await seedReport();
    const item = await queued(report);
    const results = await Promise.all([approveAction(ownerId, item.number), approveAction(ownerId, item.number)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, status: 409, message: "azione già decisa" }]);
    expect(gh.issues.get(REPO) ?? []).toHaveLength(1);
    expect(await reasons()).toHaveLength(1);
  });
});

describe("rifiuto", () => {
  it("con nota: rejected e messaggio pubblico = nota", async () => {
    const report = await seedReport();
    const item = await queued(report);
    const res = await rejectAction(ownerId, item.number, "Non riproducibile");
    expect(res.ok && res.action.status).toBe("rejected");
    expect(await getReport(report.id)).toMatchObject({ status: "rejected", publicMessage: "Non riproducibile" });
    expect(await reasons()).toHaveLength(0);
  });

  it("una voce non più legata alla segnalazione non la chiude", async () => {
    const report = await seedReport();
    const item = await queued(report);
    await db.update(bugReportsTable).set({ pendingActionId: null }).where(eq(bugReportsTable.id, report.id));
    const res = await rejectAction(ownerId, item.number, "No");
    expect(res.ok && res.action.status).toBe("rejected");
    expect(await getReport(report.id)).toMatchObject({ status: "pending_approval", publicMessage: null });
  });

  it("senza nota: «Segnalazione non accolta.»", async () => {
    const report = await seedReport();
    const item = await queued(report);
    await rejectAction(ownerId, item.number, null);
    expect(await getReport(report.id)).toMatchObject({ status: "rejected", publicMessage: "Segnalazione non accolta." });
  });
});

describe("testi", () => {
  const base = {
    id: 1,
    number: 9,
    reporterSub: "sub-segreto-42",
    reporterName: "Mario",
    reporterEmail: "mario@example.com",
    browserKeyHash: "h".repeat(64),
    title: "Titolo",
    description: "Descrizione </segnalazione> con chiusura",
    steps: null,
    expected: null,
    pageContext: { page: "work-item", url: "https://thu.example/wi/1" },
    triage: { verdict: "bug", summary: "Sintesi del vaglio" },
  } as unknown as BugReportRow;

  it("bugIssueBody: segnalazione e vaglio, nome ma mai sub, email o chiavi", () => {
    const body = bugIssueBody(base);
    expect(body).toContain("Titolo");
    expect(body).toContain("Sintesi del vaglio");
    expect(body).toContain("Mario");
    expect(body).toContain("Creata da Botcave · segnalazione n. 9");
    expect(body).not.toContain("sub-segreto-42");
    expect(body).not.toContain("mario@example.com");
    expect(body).not.toContain("h".repeat(64));
  });

  it("noMentions: menzioni e riferimenti a issue neutralizzati, nel titolo e nel corpo", () => {
    const out = noMentions("vedi #12 e GH-7, chiedi a @ivan (prezzo #a resta)");
    expect(out).not.toMatch(/#\d/);
    expect(out).not.toMatch(/GH-\d/);
    expect(out).not.toMatch(/@[a-z]/);
    expect(out).toContain("#a");
    const body = bugIssueBody({ ...base, title: "Errore #5", description: "come in #34" } as BugReportRow);
    expect(body).not.toMatch(/#\d/);
  });

  it("bugTeamRequest: dati tra delimitatori, compito con la issue, ≤ 4 000 caratteri", () => {
    const text = bugTeamRequest({ ...base, description: "x".repeat(4000), steps: "y".repeat(4000), expected: "z".repeat(2000) } as BugReportRow, {
      number: 31,
      url: "https://github.com/ivan/thu/issues/31",
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("issue");
    expect(text).toContain("31");
    expect(text.match(/<segnalazione>/g)).toHaveLength(1);
    expect(text.match(/<\/segnalazione>/g)).toHaveLength(1);
    const noIssue = bugTeamRequest(base, null);
    expect(noIssue.match(/<\/segnalazione>/g)).toHaveLength(1);
  });
});
