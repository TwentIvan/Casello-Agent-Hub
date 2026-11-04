import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appToolsTable, appsTable, skillsTable, skillVersionsTable, teamTemplatesTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret } from "../secrets";
import type { InstanceRole, TemplateRole } from "./manifest";
import { TeamRuleError } from "./rules";
import { TemplateError, createTemplate, deleteTemplate } from "./templates";
import { updateSkill, deprecateSkill } from "./skills";
import { InstanceError, closeInstance, createInstance, getInstance, listInstances, saveInstance } from "./instances";

// Istanze di squadra sul Postgres di prova (PGlite del global setup)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

let userId: number;
let appId: number;
let modelId: number;

const trole = (over: Partial<TemplateRole> = {}): TemplateRole => ({
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
const irole = (over: Partial<InstanceRole> = {}): InstanceRole => ({
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
const ref = (over: Record<string, unknown> = {}) => ({ appId, type: "wi", id: "1174", title: "Fix ordini", ...over });
const save = (roles: InstanceRole[], over: Record<string, unknown> = {}) => ({ name: "Squadra", roles, localSkills: [], ...over });

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
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  appId = app!.id;
  const [skill] = await db.insert(skillsTable).values({ code: "sap.review", name: "Review SAP", kind: "casello" }).returning();
  await db.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content: "istruzioni" });
});

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates RESTART IDENTITY CASCADE");
});

describe("istanze di squadra", () => {
  it("da modello: una skill deprecata o uno strumento disabilitato dopo il salvataggio del modello non impediscono la copia", async () => {
    const [tool] = await db.insert(appToolsTable).values({ appId, name: "crea_ordine", kind: "http", status: "active", level: "L1", definition: {} }).returning();
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [trole({ skills: ["sap.review"], tools: [tool!.id] })] });
    await deprecateSkill("sap.review");
    await db.update(appToolsTable).set({ status: "disabled" }).where(eq(appToolsTable.id, tool!.id));
    const view = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    expect(view.roles[0]!.skills[0]).toMatchObject({ code: "sap.review", deprecated: true });
    expect(view.roles[0]!.tools[0]).toMatchObject({ id: tool!.id, available: false });
  });

  it("copia dal modello fissando le skill alla versione corrente e ricorda la versione del modello", async () => {
    await updateSkill("sap.review", { content: "istruzioni v2" });
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [trole({ skills: ["sap.review"] })] });
    const view = await createInstance(userId, { templateId: template.id, name: "Squadra 1174", ref: ref() });
    expect(view).toMatchObject({
      name: "Squadra 1174",
      status: "draft",
      template: { id: template.id, name: "Sviluppo", version: 1 },
      ref: { appId, appName: "The Hub Up", type: "wi", id: "1174", title: "Fix ordini" },
      localSkills: [],
      closedAt: null,
    });
    expect(view.roles[0]!.skills[0]).toMatchObject({ code: "sap.review", version: 2, name: "Review SAP" });
    // Le modifiche successive della skill non toccano la versione fissata
    await updateSkill("sap.review", { content: "v3" });
    expect((await getInstance(view.id)).roles[0]!.skills[0]!.version).toBe(2);
  });

  it("modello archiviato → 409, modello inesistente → 404, app inesistente → 400", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [trole()] });
    await createInstance(userId, { templateId: template.id, name: "A", ref: ref() });
    await deleteTemplate(template.id); // ha un'istanza: archiviato
    await expect(createInstance(userId, { templateId: template.id, name: "B", ref: ref() })).rejects.toMatchObject({
      status: 409,
      message: "modello archiviato",
    });
    await expect(createInstance(userId, { templateId: 999, name: "B", ref: ref() })).rejects.toBeInstanceOf(TemplateError);
    await expect(createInstance(userId, { name: "B", ref: ref({ appId: 999 }), roles: [irole()] })).rejects.toMatchObject({
      status: 400,
      message: "app di riferimento inesistente",
    });
  });

  it("senza modello i ruoli sono obbligatori e la ricerca per app + tipo + id filtra", async () => {
    await expect(createInstance(userId, { name: "X", ref: ref() })).rejects.toBeInstanceOf(TeamRuleError);
    const a = await createInstance(userId, { name: "A", ref: ref(), roles: [irole()] });
    expect(a.template).toBeNull();
    const b = await createInstance(userId, { name: "B", ref: ref({ id: "2000" }), roles: [irole()] });
    expect((await listInstances({ appId, refType: "wi", refId: "1174" })).map((i) => i.id)).toEqual([a.id]);
    expect((await listInstances({ status: "draft" })).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(await listInstances({ status: "active" })).toEqual([]);
  });

  it("salva ruoli e skill specializzate, che sostituiscono le precedenti", async () => {
    const inst = await createInstance(userId, { name: "A", ref: ref(), roles: [irole()] });
    const saved = await saveInstance(
      userId,
      inst.id,
      save([irole({ localSkills: ["spec.uno"] })], {
        status: "active",
        refTitle: "Nuovo titolo",
        localSkills: [{ code: "spec.uno", name: "Specifica uno", kind: "casello", content: "fai così", toolHints: ["x"] }],
      }),
    );
    expect(saved).toMatchObject({ status: "active", ref: { title: "Nuovo titolo" } });
    expect(saved.localSkills).toEqual([{ code: "spec.uno", name: "Specifica uno", kind: "casello", content: "fai così", toolHints: ["x"] }]);
    expect(saved.roles[0]!.skills[0]).toMatchObject({ code: "spec.uno", local: true, name: "Specifica uno" });
    const replaced = await saveInstance(userId, inst.id, save([irole()], { localSkills: [{ code: "spec.due", name: "Due", kind: "casello", content: "ok" }] }));
    expect(replaced.localSkills.map((s) => s.code)).toEqual(["spec.due"]);
    expect(replaced.status).toBe("active");
  });

  it("skill specializzata usata in un ruolo ma non definita, codice doppio o contenuto non valido → 400, niente salvato", async () => {
    const inst = await createInstance(userId, { name: "A", ref: ref(), roles: [irole()] });
    await expect(saveInstance(userId, inst.id, save([irole({ localSkills: ["manca.x"] })]))).rejects.toMatchObject({
      status: 400,
      message: "skill specializzata manca.x inesistente",
    });
    const dup = { code: "spec.uno", name: "Uno", kind: "casello" as const, content: "ok" };
    await expect(saveInstance(userId, inst.id, save([irole()], { localSkills: [dup, dup] }))).rejects.toMatchObject({
      status: 400,
      message: "skill specializzata spec.uno ripetuta",
    });
    await expect(saveInstance(userId, inst.id, save([irole()], { localSkills: [{ ...dup, content: "  " }] }))).rejects.toBeInstanceOf(TeamRuleError);
    await expect(saveInstance(userId, inst.id, save([irole()], { localSkills: [{ ...dup, kind: "node", content: "non valido!" }] }))).rejects.toBeInstanceOf(TeamRuleError);
    const after = await getInstance(inst.id);
    expect(after.localSkills).toEqual([]);
    expect(after.name).toBe("A");
  });

  it("una skill del catalogo deprecata dopo la copia non impedisce di salvare gli stessi ruoli", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [trole({ skills: ["sap.review"] })] });
    const inst = await createInstance(userId, { templateId: template.id, name: "A", ref: ref() });
    await deprecateSkill("sap.review");
    const roles = inst.roles.map(() => irole({ skills: [{ code: "sap.review", version: 1 }] }));
    const saved = await saveInstance(userId, inst.id, save(roles, { name: "Rinominata" }));
    expect(saved.name).toBe("Rinominata");
    expect(saved.roles[0]!.skills[0]).toMatchObject({ code: "sap.review", deprecated: true });
  });

  it("chiusa: non si salva più (409), non si richiude, non cambia stato con status closed", async () => {
    const inst = await createInstance(userId, { name: "A", ref: ref(), roles: [irole()] });
    const closed = await closeInstance(inst.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeInstanceOf(Date);
    await expect(saveInstance(userId, inst.id, save([irole()]))).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(closeInstance(inst.id)).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(getInstance(999)).rejects.toBeInstanceOf(InstanceError);
  });

  it("l'eliminazione del modello lascia l'istanza senza origine", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [trole()] });
    const inst = await createInstance(userId, { templateId: template.id, name: "A", ref: ref() });
    await db.delete(teamTemplatesTable).where(eq(teamTemplatesTable.id, template.id));
    expect((await getInstance(inst.id)).template).toBeNull();
  });
});
