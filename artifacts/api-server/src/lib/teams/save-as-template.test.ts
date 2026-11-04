import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, skillsTable, skillVersionsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { TemplateRole } from "./manifest";
import { createTemplate, deleteTemplate, getTemplate, listTemplates } from "./templates";
import { createInstance, getInstance, saveInstance } from "./instances";
import { getSkill, listSkills } from "./skills";
import { getUpdates } from "./updates";
import { saveInstanceAsTemplate } from "./save-as-template";

// «Salva come modello» sul Postgres di prova (PGlite)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

describe("saveInstanceAsTemplate", () => {
  let userId: number;
  let modelId: number;
  let appId: number;
  const tr = (over: Partial<TemplateRole> = {}): TemplateRole => ({
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
  const ref = () => ({ appId, type: "wi", id: "1" });

  beforeEach(async () => {
    await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates, team_instances RESTART IDENTITY CASCADE");
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
    const [skill] = await db.insert(skillsTable).values({ code: "sap.review", name: "Review", kind: "casello" }).returning();
    await db.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content: "istruzioni" });
  });

  afterAll(async () => {
    await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates, team_instances RESTART IDENTITY CASCADE");
  });

  /** Istanza da un modello con una skill del catalogo, più due specializzate (una sola nel ruolo capo). */
  async function setup() {
    const template = await createTemplate(userId, { name: "Sviluppo", description: "Squadra base", roles: [tr({ skills: ["sap.review"] })] });
    const inst = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    await saveInstance(userId, inst.id, {
      name: "S",
      roles: [{ ...tr(), skills: [{ code: "sap.review", version: 1 }], localSkills: ["spec.uno", "spec.due"] }],
      localSkills: [
        { code: "spec.uno", name: "Uno", kind: "casello", content: "fai uno", toolHints: ["x"] },
        { code: "spec.due", name: "Due", kind: "casello", content: "fai due" },
      ],
    });
    return { template, inst };
  }

  it("new: promuove una skill (v1 nel catalogo, nel ruolo) e toglie quella non promossa", async () => {
    const { inst } = await setup();
    const saved = await saveInstanceAsTemplate(userId, inst.id, { mode: "new", name: "Da squadra", promote: [{ localCode: "spec.uno", code: "team.uno" }] });
    expect(saved).toMatchObject({ name: "Da squadra", version: 1 });
    expect(saved.roles[0]!.skills.map((s) => [s.code, s.version])).toEqual([
      ["sap.review", undefined],
      ["team.uno", undefined],
    ]);
    const skill = await getSkill("team.uno");
    expect(skill).toMatchObject({ name: "Uno", kind: "casello", currentVersion: 1, content: "fai uno", toolHints: ["x"] });
    expect((await listSkills()).map((s) => s.code)).toEqual(["sap.review", "team.uno"]);
    expect(await listTemplates({ archived: false })).toHaveLength(2);
  });

  it("new_version con una skill promossa: l'istanza d'origine segue la nuova versione, senza aggiornamenti spuri", async () => {
    const { template, inst } = await setup();
    const saved = await saveInstanceAsTemplate(userId, inst.id, { mode: "new_version", promote: [{ localCode: "spec.uno", code: "team.uno" }] });
    expect(saved.version).toBe(2);
    expect(await getUpdates(inst.id)).toEqual([]);
    const after = await getInstance(inst.id);
    expect(after.template).toMatchObject({ id: template.id, version: 2 });
    expect(after.roles[0]!.skills.map((s) => [s.code, s.version])).toEqual([
      ["sap.review", 1],
      ["team.uno", 1],
      ["spec.due", undefined],
    ]);
    expect(after.localSkills.map((s) => s.code)).toEqual(["spec.due"]);
  });

  it("new senza nome → 400", async () => {
    const { inst } = await setup();
    await expect(saveInstanceAsTemplate(userId, inst.id, { mode: "new" })).rejects.toMatchObject({ status: 400 });
  });

  it("new_version: versione successiva del modello d'origine, con nome e descrizione invariati", async () => {
    const { inst, template } = await setup();
    const saved = await saveInstanceAsTemplate(userId, inst.id, { mode: "new_version", name: "Ignorato", promote: [{ localCode: "spec.due", code: "team.due" }] });
    expect(saved).toMatchObject({ id: template.id, name: "Sviluppo", description: "Squadra base", version: 2 });
    expect(saved.roles[0]!.skills.map((s) => s.code)).toEqual(["sap.review", "team.due"]);
    expect((await getTemplate(template.id)).version).toBe(2);
  });

  it("new_version senza modello → 409; con modello archiviato → 409", async () => {
    const noTemplate = await createInstance(userId, { name: "Z", ref: ref(), roles: [{ ...tr(), skills: [], localSkills: [] }] });
    await expect(saveInstanceAsTemplate(userId, noTemplate.id, { mode: "new_version" })).rejects.toMatchObject({
      status: 409,
      message: "l'istanza non ha un modello",
    });
    const { inst, template } = await setup();
    await deleteTemplate(template.id);
    await expect(saveInstanceAsTemplate(userId, inst.id, { mode: "new_version" })).rejects.toMatchObject({ status: 409, message: "modello archiviato" });
    await expect(saveInstanceAsTemplate(userId, 999, { mode: "new", name: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("codice di promozione già usato → 409 e nulla creato", async () => {
    const { inst } = await setup();
    await expect(
      saveInstanceAsTemplate(userId, inst.id, {
        mode: "new",
        name: "Da squadra",
        promote: [
          { localCode: "spec.uno", code: "team.uno" },
          { localCode: "spec.due", code: "sap.review" },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, message: "codice già usato" });
    expect((await listSkills()).map((s) => s.code)).toEqual(["sap.review"]);
    expect(await listTemplates({ archived: false })).toHaveLength(1);
  });

  it("nome del modello già usato → 409 e le skill promosse non restano (tutto o niente)", async () => {
    const { inst } = await setup();
    await expect(
      saveInstanceAsTemplate(userId, inst.id, { mode: "new", name: "Sviluppo", promote: [{ localCode: "spec.uno", code: "team.uno" }] }),
    ).rejects.toMatchObject({ status: 409, message: "nome già usato" });
    expect((await listSkills()).map((s) => s.code)).toEqual(["sap.review"]);
  });

  it("promozioni non valide: skill locale inesistente, codice ripetuto o non valido → 400", async () => {
    const { inst } = await setup();
    const run = (promote: { localCode: string; code: string }[]) => saveInstanceAsTemplate(userId, inst.id, { mode: "new", name: "N", promote });
    await expect(run([{ localCode: "nope.x", code: "team.uno" }])).rejects.toMatchObject({ status: 400 });
    await expect(run([{ localCode: "spec.uno", code: "Maiuscolo!" }])).rejects.toMatchObject({ status: 400 });
    await expect(
      run([
        { localCode: "spec.uno", code: "team.x" },
        { localCode: "spec.due", code: "team.x" },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
