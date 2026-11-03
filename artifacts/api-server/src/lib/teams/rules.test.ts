import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, appToolsTable, skillsTable, skillVersionsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import { InstanceRoleSchema, TemplateRoleSchema, type InstanceRole, type TemplateRole } from "./manifest";
import { TEAM_MESSAGES, TeamRuleError, validateRoles } from "./rules";
import type { SkillKind } from "./skills";

// Regole di salvataggio di modelli e istanze sul Postgres di prova (PGlite del global setup)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

let userId: number;
let otherModel: number;
let myModel: number;

async function modelFor(owner: number, modelId: string): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: owner, name: `A ${modelId}`, provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId, displayName: modelId }).returning();
  return model!.id;
}

async function skill(code: string, kind: SkillKind = "casello", deprecated = false): Promise<number> {
  const [row] = await db.insert(skillsTable).values({ code, name: code, kind, deprecated }).returning();
  await db.insert(skillVersionsTable).values({ skillId: row!.id, version: 1, content: kind === "node" ? "nome:nodo" : "istruzioni" });
  return row!.id;
}

async function tool(name: string, extra: Partial<typeof appToolsTable.$inferInsert> = {}): Promise<number> {
  const [app] = await db.insert(appsTable).values({ name: `App ${name}`, slug: `app-${name}`, baseUrl: "https://a.example.com" }).returning();
  const [row] = await db
    .insert(appToolsTable)
    .values({ appId: app!.id, name, kind: "http", status: "active", level: "L1", definition: {}, ...extra })
    .returning();
  return row!.id;
}

const role = (over: Partial<TemplateRole> = {}): TemplateRole => ({
  key: "capo",
  name: "Capo",
  task: "",
  isLead: true,
  runsOn: "cloud",
  aiModelId: myModel,
  tools: [],
  skills: [],
  ...over,
});

const instRole = (over: Partial<InstanceRole> = {}): InstanceRole => ({ ...role(), skills: [], localSkills: [], ...over } as InstanceRole);

async function expectError(promise: Promise<void>, message: string) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TeamRuleError);
  expect((err as TeamRuleError).status).toBe(400);
  expect((err as TeamRuleError).message).toBe(message);
}

const template = (roles: TemplateRole[], previous: TemplateRole[] | null = null) =>
  validateRoles({ roles, mode: "template", userId, previous });

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "me@example.com", name: "Io" }).returning();
  const [o] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  userId = u!.id;
  myModel = await modelFor(userId, "mio");
  otherModel = await modelFor(o!.id, "altrui");
});

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills RESTART IDENTITY CASCADE");
});

describe("schema del manifesto", () => {
  it("rifiuta chiavi non valide, compiti lunghi e ripetizioni", () => {
    expect(TemplateRoleSchema.safeParse(role()).success).toBe(true);
    expect(TemplateRoleSchema.safeParse(role({ key: "Maiuscola" })).success).toBe(false);
    expect(TemplateRoleSchema.safeParse(role({ task: "x".repeat(8001) })).success).toBe(false);
    expect(TemplateRoleSchema.safeParse(role({ tools: [1, 1] })).success).toBe(false);
    expect(TemplateRoleSchema.safeParse(role({ skills: ["aa", "aa"] })).success).toBe(false);
    expect(InstanceRoleSchema.safeParse(instRole({ skills: [{ code: "aa", version: 1 }, { code: "aa", version: 2 }] })).success).toBe(false);
    expect(InstanceRoleSchema.safeParse(instRole()).success).toBe(true);
  });
});

describe("regole di struttura", () => {
  it("accetta una squadra valida", async () => {
    await expect(template([role(), role({ key: "dev", name: "Dev", isLead: false })])).resolves.toBeUndefined();
  });

  it("esige esattamente un capo", async () => {
    await expectError(template([role({ isLead: false })]), TEAM_MESSAGES.oneLead);
    await expectError(template([role(), role({ key: "b", name: "B" })]), TEAM_MESSAGES.oneLead);
  });

  it("nomi e chiavi doppi", async () => {
    await expectError(template([role(), role({ key: "b", isLead: false })]), TEAM_MESSAGES.duplicateName);
    await expectError(template([role(), role({ name: "B", isLead: false })]), TEAM_MESSAGES.duplicateKey);
  });

  it("più di 20 ruoli", async () => {
    const roles = Array.from({ length: 21 }, (_, i) => role({ key: `r${i}`, name: `R${i}`, isLead: i === 0 }));
    await expectError(template(roles), TEAM_MESSAGES.tooManyRoles);
  });

  it("più di 30 skill in un ruolo", async () => {
    const skills = Array.from({ length: 31 }, (_, i) => `skill${i}`);
    await expectError(template([role({ skills })]), TEAM_MESSAGES.tooManySkills("Capo"));
  });
});

describe("modello e luogo", () => {
  it("cloud senza modello o con modello altrui", async () => {
    await expectError(template([role({ aiModelId: null })]), TEAM_MESSAGES.modelUnavailable);
    await expectError(template([role({ aiModelId: otherModel })]), TEAM_MESSAGES.modelUnavailable);
    await expectError(template([role({ aiModelId: 999_999 })]), TEAM_MESSAGES.modelUnavailable);
  });

  it("node con modello", async () => {
    await expectError(template([role({ runsOn: "node", aiModelId: myModel })]), TEAM_MESSAGES.nodeRoleHasModel);
    await expect(template([role({ runsOn: "node", aiModelId: null })])).resolves.toBeUndefined();
  });
});

describe("skill", () => {
  it("skill node su ruolo cloud", async () => {
    await skill("sap.nodo", "node");
    await expectError(template([role({ skills: ["sap.nodo"] })]), TEAM_MESSAGES.skillNodeOnly("sap.nodo"));
    await expect(template([role({ runsOn: "node", aiModelId: null, skills: ["sap.nodo"] })])).resolves.toBeUndefined();
  });

  it("codice inesistente", async () => {
    await expectError(template([role({ skills: ["non.esiste"] })]), TEAM_MESSAGES.skillNotFound("non.esiste"));
  });

  it("skill deprecata: errore in un ruolo nuovo, ok se già nel ruolo con la stessa chiave", async () => {
    await skill("vecchia", "casello", true);
    await expectError(template([role({ skills: ["vecchia"] })]), TEAM_MESSAGES.skillDeprecated("vecchia"));
    await expectError(
      template([role({ skills: ["vecchia"] })], [role({ key: "altra", name: "Altra", skills: ["vecchia"] })]),
      TEAM_MESSAGES.skillDeprecated("vecchia"),
    );
    await expect(template([role({ skills: ["vecchia"] })], [role({ skills: ["vecchia"] })])).resolves.toBeUndefined();
  });

  it("istanza: versione inesistente", async () => {
    await skill("sap.a");
    const run = (version: number) =>
      validateRoles({ roles: [instRole({ skills: [{ code: "sap.a", version }] })], mode: "instance", userId, previous: null });
    await expect(run(1)).resolves.toBeUndefined();
    await expectError(run(2), TEAM_MESSAGES.skillVersionNotFound(2, "sap.a"));
  });

  it("istanza: skill specializzate", async () => {
    const run = (localSkills: string[], map: Map<string, SkillKind>, roleOver: Partial<InstanceRole> = {}) =>
      validateRoles({ roles: [instRole({ localSkills, ...roleOver })], mode: "instance", userId, previous: null, localSkillCodes: map });
    await expectError(run(["loc"], new Map()), TEAM_MESSAGES.localSkillNotFound("loc"));
    await expect(run(["loc"], new Map([["loc", "casello" as SkillKind]]))).resolves.toBeUndefined();
    await expectError(run(["loc"], new Map([["loc", "node" as SkillKind]])), TEAM_MESSAGES.skillNodeOnly("loc"));
    await expect(run(["loc"], new Map([["loc", "node" as SkillKind]]), { runsOn: "node", aiModelId: null })).resolves.toBeUndefined();
  });
});

describe("strumenti", () => {
  it("strumento disattivato: errore se nuovo, ok se già nel ruolo", async () => {
    const id = await tool("t1", { status: "disabled" });
    await expectError(template([role({ tools: [id] })]), TEAM_MESSAGES.toolNotUsable("t1"));
    await expect(template([role({ tools: [id] })], [role({ tools: [id] })])).resolves.toBeUndefined();
    await expectError(template([role({ tools: [id] })], [role({ key: "altra", name: "Altra", tools: [id] })]), TEAM_MESSAGES.toolNotUsable("t1"));
  });

  it("strumento con livello effettivo L3 (anche per deroga)", async () => {
    const l3 = await tool("t2", { level: "L3" });
    const over = await tool("t3", { level: "L1", levelOverride: "L3" });
    await expectError(template([role({ tools: [l3] })]), TEAM_MESSAGES.toolNotUsable("t2"));
    await expectError(template([role({ tools: [over] })]), TEAM_MESSAGES.toolNotUsable("t3"));
  });

  it("strumento attivo e strumento inesistente", async () => {
    const ok = await tool("t4");
    await expect(template([role({ tools: [ok] })])).resolves.toBeUndefined();
    await expectError(template([role({ tools: [999_999] })]), TEAM_MESSAGES.toolNotUsable("#999999"));
  });
});
