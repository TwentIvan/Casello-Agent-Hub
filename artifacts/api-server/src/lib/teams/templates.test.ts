import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  appToolsTable,
  skillsTable,
  skillVersionsTable,
  teamInstancesTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret } from "../secrets";
import type { InstanceRole, TemplateRole } from "./manifest";
import { TeamRuleError, TEAM_MESSAGES } from "./rules";
import {
  TemplateError,
  createTemplate,
  deleteTemplate,
  describeRoles,
  getTemplate,
  getTemplateVersion,
  listTemplates,
  saveTemplate,
} from "./templates";

// Modelli di squadra sul Postgres di prova (PGlite del global setup)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

let userId: number;
let appId: number;
let toolId: number;
let modelId: number;

const role = (over: Partial<TemplateRole> = {}): TemplateRole => ({
  key: "capo",
  name: "Capo",
  task: "Coordina",
  isLead: true,
  runsOn: "cloud",
  aiModelId: modelId,
  tools: [],
  skills: [],
  ...over,
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "me@example.com", name: "Io" }).returning();
  userId = u!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "Modello uno" }).returning();
  modelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "https://a.example.com" }).returning();
  appId = app!.id;
  const [tool] = await db.insert(appToolsTable).values({ appId, name: "crea_ordine", kind: "http", status: "active", level: "L1", definition: {} }).returning();
  toolId = tool!.id;
  const [skill] = await db.insert(skillsTable).values({ code: "sap.review", name: "Review SAP", kind: "casello" }).returning();
  await db.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content: "istruzioni" });
});

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates RESTART IDENTITY CASCADE");
});

describe("modelli di squadra", () => {
  it("crea la versione 1 e rilegge i ruoli arricchiti", async () => {
    const created = await createTemplate(userId, {
      name: "Sviluppo",
      description: "Squadra base",
      roles: [role({ tools: [toolId], skills: ["sap.review"] })],
    });
    expect(created).toMatchObject({ name: "Sviluppo", description: "Squadra base", version: 1, archived: false, instanceCount: 0 });
    expect(created.roles[0]).toMatchObject({
      key: "capo",
      model: { id: modelId, name: "Modello uno" },
      tools: [{ id: toolId, appId, appName: "Mister", name: "crea_ordine", level: "L1", available: true }],
      skills: [{ code: "sap.review", name: "Review SAP", kind: "casello", deprecated: false }],
    });
    expect((await getTemplate(created.id)).roles).toEqual(created.roles);
    expect((await listTemplates({ archived: false })).map((t) => t.id)).toEqual([created.id]);
    expect(await listTemplates({ archived: true })).toEqual([]);
  });

  it("il salvataggio crea la v2 e lascia leggibile la v1", async () => {
    const created = await createTemplate(userId, { name: "Sviluppo", roles: [role()] });
    const saved = await saveTemplate(userId, created.id, {
      name: "Sviluppo 2",
      roles: [role({ task: "Nuovo compito" }), role({ key: "dev", name: "Dev", isLead: false })],
    });
    expect(saved).toMatchObject({ version: 2, name: "Sviluppo 2" });
    expect(saved.roles).toHaveLength(2);
    const v1 = await getTemplateVersion(created.id, 1);
    expect(v1).toHaveLength(1);
    expect(v1[0]!.task).toBe("Coordina");
    await expect(getTemplateVersion(created.id, 3)).rejects.toMatchObject({ status: 404 });
  });

  it("una regola violata dà 400 e non crea nessuna versione", async () => {
    const created = await createTemplate(userId, { name: "Sviluppo", roles: [role()] });
    const err = await saveTemplate(userId, created.id, { name: "Cambiato", roles: [role({ isLead: false })] }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TeamRuleError);
    expect((err as TeamRuleError).message).toBe(TEAM_MESSAGES.oneLead);
    const after = await getTemplate(created.id);
    expect(after).toMatchObject({ version: 1, name: "Sviluppo" });
    const versions = await pool.query("select count(*)::int as n from team_template_versions");
    expect(versions.rows[0].n).toBe(1);
  });

  it("il nome è unico tra i non archiviati (409)", async () => {
    const a = await createTemplate(userId, { name: "Sviluppo", roles: [role()] });
    const err = await createTemplate(userId, { name: "Sviluppo", roles: [role()] }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err).toMatchObject({ status: 409, message: "nome già usato" });
    const b = await createTemplate(userId, { name: "Altro", roles: [role()] });
    await expect(saveTemplate(userId, b.id, { name: "Sviluppo", roles: [role()] })).rejects.toMatchObject({ status: 409, message: "nome già usato" });
    expect((await getTemplate(b.id)).version).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  it("uno strumento eliminato dall'app dopo il salvataggio non rompe la lettura", async () => {
    const created = await createTemplate(userId, { name: "Sviluppo", roles: [role({ tools: [toolId] })] });
    await db.delete(appToolsTable).where(eq(appToolsTable.id, toolId));
    const read = await getTemplate(created.id);
    expect(read.roles[0]!.tools).toEqual([{ id: toolId, name: "strumento eliminato", available: false }]);
  });

  it("uno strumento disattivato o L3 risulta non disponibile", async () => {
    const created = await createTemplate(userId, { name: "Sviluppo", roles: [role({ tools: [toolId] })] });
    await db.update(appToolsTable).set({ status: "disabled" }).where(eq(appToolsTable.id, toolId));
    expect((await getTemplate(created.id)).roles[0]!.tools[0]).toMatchObject({ available: false });
    await db.update(appToolsTable).set({ status: "active", levelOverride: "L3" }).where(eq(appToolsTable.id, toolId));
    expect((await getTemplate(created.id)).roles[0]!.tools[0]).toMatchObject({ level: "L3", available: false });
  });

  it("delete: senza istanze cancella, con un'istanza archivia", async () => {
    const free = await createTemplate(userId, { name: "Libero", roles: [role()] });
    expect(await deleteTemplate(free.id)).toEqual({ deleted: true, archived: false });
    await expect(getTemplate(free.id)).rejects.toMatchObject({ status: 404 });

    const used = await createTemplate(userId, { name: "Usato", roles: [role()] });
    await db.insert(teamInstancesTable).values({ name: "Squadra", templateId: used.id, templateVersion: 1, refAppId: appId, refType: "issue", refId: "1", refTitle: "T" });
    expect((await getTemplate(used.id)).instanceCount).toBe(1);
    expect(await deleteTemplate(used.id)).toEqual({ deleted: false, archived: true });
    expect((await getTemplate(used.id)).archived).toBe(true);
    expect((await listTemplates({ archived: true })).map((t) => t.id)).toEqual([used.id]);
    expect(await listTemplates({ archived: false })).toEqual([]);
    // un modello archiviato non si salva più, e il suo nome si può riusare
    await expect(saveTemplate(userId, used.id, { name: "Usato", roles: [role()] })).rejects.toMatchObject({ status: 409 });
    await expect(createTemplate(userId, { name: "Usato", roles: [role()] })).resolves.toMatchObject({ version: 1 });
  });

  it("describeRoles legge anche i ruoli di un'istanza (versione e skill specializzate)", async () => {
    const inst: InstanceRole = { ...role({ tools: [toolId] }), skills: [{ code: "sap.review", version: 1 }], localSkills: ["mia-skill"] };
    const [view] = await describeRoles([inst], new Map([["mia-skill", { name: "Mia skill", kind: "node" as const }]]));
    expect(view!.skills).toEqual([
      { code: "sap.review", version: 1, name: "Review SAP", kind: "casello", deprecated: false },
      { code: "mia-skill", name: "Mia skill", kind: "node", deprecated: false, local: true },
    ]);
  });

  it("accetta un esecutore esplicito come ultimo parametro", async () => {
    const created = await createTemplate(userId, { name: "Esplicito", roles: [role()] }, db);
    await expect(saveTemplate(userId, created.id, { name: "Esplicito", roles: [role()] }, db)).resolves.toMatchObject({ version: 2 });
  });

  it("modello assente o di nodo: model null", async () => {
    const [view] = await describeRoles([role({ runsOn: "node", aiModelId: null })]);
    expect(view!.model).toBeNull();
  });
})
