import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  skillsTable,
  skillVersionsTable,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamChatProposalsTable,
  teamInstanceSkillsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { InstanceRole } from "../teams/manifest";
import { closeInstance, createInstance, getInstance, saveInstance } from "../teams/instances";
import { TeamRuleError } from "../teams/rules";
import { TEAM_CHAT_MESSAGES, TeamChatError, currentValueHash, decideTeamChatProposal } from "./decide";

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

let userId: number;
let otherUserId: number;
let modelId: number;
let instanceId: number;
let conversationId: number;
let messageId: number;

const role = (over: Partial<InstanceRole> = {}): InstanceRole => ({
  key: "capo",
  name: "Capo",
  task: "Coordina",
  isLead: true,
  runsOn: "cloud",
  aiModelId: modelId,
  tools: [],
  skills: [],
  localSkills: [],
  ...over,
});

const MD = (key = "dev", body = "Scrive codice.") => `---\nname: ${key}\ndescription: Quando serve sviluppare\n---\n# Sviluppatore\n\n## Identità\n${body}\n`;

async function propose(kind: "role_identity" | "role_instructions", roleKey: string, payload: unknown): Promise<number> {
  const instance = await getInstance(instanceId);
  const [row] = await db
    .insert(teamChatProposalsTable)
    .values({ conversationId, messageId, kind, roleKey, payload, rationale: "serve", targetHash: currentValueHash(instance, kind, roleKey) })
    .returning();
  return row!.id;
}

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "me@example.com", name: "Io" }).returning();
  userId = u!.id;
  const [o] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  otherUserId = o!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "Modello uno" }).returning();
  modelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  const view = await createInstance(userId, {
    name: "Squadra",
    ref: { appId: app!.id, type: "wi", id: "1174" },
    roles: [role(), role({ key: "dev", name: "Sviluppatore", task: "Sviluppa", isLead: false })],
  });
  instanceId = view.id;
  const [conv] = await db.insert(teamChatConversationsTable).values({ teamInstanceId: instanceId, userId, aiModelId: modelId, title: "t" }).returning();
  conversationId = conv!.id;
  const [msg] = await db.insert(teamChatMessagesTable).values({ conversationId, role: "assistant", content: "Ecco" }).returning();
  messageId = msg!.id;
});

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates RESTART IDENTITY CASCADE");
});

describe("decisione sulle schede della chat di squadra", () => {
  it("hash: identità e istruzioni, stringa vuota se mancano", async () => {
    const instance = await getInstance(instanceId);
    expect(currentValueHash(instance, "role_identity", "dev")).toMatch(/^[0-9a-f]{64}$/);
    expect(currentValueHash(instance, "role_identity", "nessuno")).toBe("");
    expect(currentValueHash(instance, "role_instructions", "dev")).toBe("");
  });

  it("accettare l'identità aggiorna roles[key].task", async () => {
    const id = await propose("role_identity", "dev", { text: "Sviluppatore backend esperto" });
    const view = await decideTeamChatProposal(userId, id, "accept");
    expect(view).toMatchObject({ id, status: "accepted", kind: "role_identity", roleKey: "dev" });
    expect(view.decidedAt).toBeInstanceOf(Date);
    const instance = await getInstance(instanceId);
    expect(instance.roles.find((r) => r.key === "dev")!.task).toBe("Sviluppatore backend esperto");
    expect(instance.roles.find((r) => r.key === "capo")!.task).toBe("Coordina");
  });

  it("accettare le istruzioni crea la skill ruolo-dev e la aggiunge al ruolo; una seconda accettazione la sostituisce", async () => {
    const first = await propose("role_instructions", "dev", { markdown: MD() });
    await decideTeamChatProposal(userId, first, "accept");
    let instance = await getInstance(instanceId);
    expect(instance.localSkills).toEqual([
      { code: "ruolo-dev", name: "Istruzioni · Sviluppatore", kind: "casello", content: MD(), toolHints: [] },
    ]);
    expect(instance.roles.find((r) => r.key === "dev")!.skills).toEqual([expect.objectContaining({ code: "ruolo-dev", local: true })]);

    const second = await propose("role_instructions", "dev", { markdown: MD("dev", "Scrive test.") });
    await decideTeamChatProposal(userId, second, "accept");
    instance = await getInstance(instanceId);
    expect(instance.localSkills).toHaveLength(1);
    expect(instance.localSkills[0]!.content).toBe(MD("dev", "Scrive test."));
    expect(instance.roles.find((r) => r.key === "dev")!.skills).toHaveLength(1);
  });

  it("due proposte nate sullo stesso valore: la seconda diventa stale con 409", async () => {
    const a = await propose("role_identity", "dev", { text: "Prima" });
    const b = await propose("role_identity", "dev", { text: "Seconda" });
    await decideTeamChatProposal(userId, a, "accept");
    await expect(decideTeamChatProposal(userId, b, "accept")).rejects.toMatchObject({ status: 409, message: TEAM_CHAT_MESSAGES.stale });
    const [row] = await db.select().from(teamChatProposalsTable).where(eq(teamChatProposalsTable.id, b));
    expect(row!.status).toBe("stale");
    expect((await getInstance(instanceId)).roles.find((r) => r.key === "dev")!.task).toBe("Prima");
  });

  it("ruolo con 30 skill: le istruzioni non entrano (400) e la scheda resta pending", async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    for (const code of codes) {
      const [s] = await db.insert(skillsTable).values({ code, name: code, kind: "casello" }).returning();
      await db.insert(skillVersionsTable).values({ skillId: s!.id, version: 1, content: "x" });
    }
    const current = await getInstance(instanceId);
    await saveInstance(userId, instanceId, {
      name: current.name,
      roles: [role(), role({ key: "dev", name: "Sviluppatore", task: "Sviluppa", isLead: false, skills: codes.map((code) => ({ code, version: 1 })) })],
      localSkills: [],
    });
    const id = await propose("role_instructions", "dev", { markdown: MD() });
    const err = await decideTeamChatProposal(userId, id, "accept").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamRuleError);
    expect((err as TeamRuleError).status).toBe(400);
    const [row] = await db.select().from(teamChatProposalsTable).where(eq(teamChatProposalsTable.id, id));
    expect(row!.status).toBe("pending");
    expect(await db.select().from(teamInstanceSkillsTable)).toEqual([]);
  });

  it("squadra chiusa: accettare e rifiutare rispondono 409", async () => {
    const id = await propose("role_identity", "dev", { text: "Nuova" });
    await closeInstance(instanceId);
    await expect(decideTeamChatProposal(userId, id, "accept")).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(decideTeamChatProposal(userId, id, "reject")).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
  });

  it("rifiutare, scheda già decisa, scheda di un altro utente", async () => {
    const id = await propose("role_identity", "dev", { text: "Nuova" });
    await expect(decideTeamChatProposal(otherUserId, id, "reject")).rejects.toMatchObject({ status: 404 });
    const view = await decideTeamChatProposal(userId, id, "reject");
    expect(view.status).toBe("rejected");
    await expect(decideTeamChatProposal(userId, id, "accept")).rejects.toMatchObject({ status: 409, message: TEAM_CHAT_MESSAGES.alreadyDecided });
    expect(TEAM_CHAT_MESSAGES.alreadyDecided).toBe("scheda già decisa");
    expect(TEAM_CHAT_MESSAGES.stale).toBe("la squadra è cambiata: chiedi a Lucius una proposta aggiornata");
    await expect(decideTeamChatProposal(userId, 9999, "accept")).rejects.toBeInstanceOf(TeamChatError);
  });

  it("due accettazioni concorrenti su ruoli diversi: restano entrambe le modifiche", async () => {
    const a = await propose("role_identity", "dev", { text: "Identità dev" });
    const b = await propose("role_instructions", "capo", { markdown: MD("capo") });
    const c = await propose("role_identity", "capo", { text: "Identità capo" });
    const views = await Promise.all([a, b, c].map((id) => decideTeamChatProposal(userId, id, "accept")));
    expect(views.map((v) => v.status)).toEqual(["accepted", "accepted", "accepted"]);
    const instance = await getInstance(instanceId);
    expect(instance.roles.find((r) => r.key === "dev")!.task).toBe("Identità dev");
    expect(instance.roles.find((r) => r.key === "capo")!.task).toBe("Identità capo");
    expect(instance.localSkills.map((s) => s.code)).toEqual(["ruolo-capo"]);
    expect(instance.roles.find((r) => r.key === "capo")!.skills.map((s) => s.code)).toEqual(["ruolo-capo"]);
  });

  it("un'accettazione in corsa con un salvataggio dall'editor non annulla la modifica dell'editor", async () => {
    const id = await propose("role_identity", "dev", { text: "Identità dev" });
    const current = await getInstance(instanceId);
    const editor = saveInstance(userId, instanceId, {
      name: "Squadra rinominata",
      roles: [role({ task: "Coordina meglio" }), role({ key: "dev", name: "Sviluppatore", task: "Sviluppa", isLead: false })],
      localSkills: [],
    });
    const [, view] = await Promise.all([editor, decideTeamChatProposal(userId, id, "accept")]);
    expect(view.status).toBe("accepted");
    const instance = await getInstance(instanceId);
    expect(current.name).toBe("Squadra");
    expect(instance.name).toBe("Squadra rinominata");
    expect(instance.roles.find((r) => r.key === "capo")!.task).toBe("Coordina meglio");
    expect(instance.roles.find((r) => r.key === "dev")!.task).toBe("Identità dev");
  });

  it("istruzioni con un frontmatter non valido non si accettano", async () => {
    const id = await propose("role_instructions", "dev", { markdown: MD("tester") });
    await expect(decideTeamChatProposal(userId, id, "accept")).rejects.toMatchObject({ status: 400, message: "il nome nel frontmatter deve essere dev" });
  });
});
