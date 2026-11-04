import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, skillsTable, skillVersionsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { InstanceRole, TemplateRole } from "./manifest";
import { createTemplate, saveTemplate } from "./templates";
import { updateSkill } from "./skills";
import { InstanceError, closeInstance, createInstance, getInstance, saveInstance } from "./instances";
import { applyUpdates, computeUpdates, getUpdates } from "./updates";

// Aggiornamenti proposti alle istanze: calcolo puro e applicazione sul Postgres di prova (PGlite)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

const trole = (over: Partial<TemplateRole> = {}): TemplateRole => ({
  key: "capo",
  name: "Capo",
  task: "Coordina",
  isLead: true,
  runsOn: "cloud",
  aiModelId: 1,
  tools: [],
  skills: [],
  ...over,
});
const irole = (over: Partial<InstanceRole> = {}): InstanceRole => ({ ...trole(), skills: [], localSkills: [], ...over } as InstanceRole);
const pin = (role: TemplateRole, version = 1): InstanceRole => ({ ...role, skills: role.skills.map((code) => ({ code, version })), localSkills: [] });
const noSkills = new Map<string, number>();

describe("computeUpdates", () => {
  it("nessuna voce se il modello corrente ha lo stesso contenuto (anche con un numero di versione diverso)", () => {
    const roles = [trole({ tools: [1, 2], skills: ["a.b"] })];
    const current = [trole({ tools: [2, 1], skills: ["a.b"] })];
    expect(computeUpdates({ base: roles, current, instance: roles.map((r) => pin(r)), skillVersions: new Map([["a.b", 1]]) })).toEqual([]);
  });

  it("ruolo rinominato (stessa key) → una sola role_changed name, non tolto + aggiunto", () => {
    const base = [trole()];
    const items = computeUpdates({ base, current: [trole({ name: "Coordinatore" })], instance: base.map((r) => pin(r)), skillVersions: noSkills });
    expect(items).toEqual([
      { id: "role_changed:capo:name", type: "role_changed", roleKey: "capo", roleName: "Capo", field: "name", from: "Capo", to: "Coordinatore" },
    ]);
  });

  it("ruolo aggiunto e tolto nel modello", () => {
    const dev = trole({ key: "dev", name: "Sviluppatore", isLead: false, skills: ["a.b"] });
    const qa = trole({ key: "qa", name: "Collaudo", isLead: false });
    const base = [trole(), qa];
    const items = computeUpdates({ base, current: [trole(), dev], instance: base.map((r) => pin(r)), skillVersions: noSkills });
    expect(items).toEqual([
      { id: "role_added:dev", type: "role_added", roleKey: "dev", roleName: "Sviluppatore", to: dev },
      { id: "role_removed:qa", type: "role_removed", roleKey: "qa", roleName: "Collaudo" },
    ]);
    // Ruolo già aggiunto nell'istanza o già tolto: nessuna voce
    expect(computeUpdates({ base, current: [trole(), dev], instance: [pin(trole()), pin(dev)], skillVersions: noSkills })).toEqual([]);
  });

  it("compito cambiato nel modello → role_changed task; cambiato solo nell'istanza → nessuna voce", () => {
    const base = [trole()];
    const instance = [irole({ task: "Compito mio" })];
    expect(computeUpdates({ base, current: [trole({ task: "Nuovo" })], instance, skillVersions: noSkills })).toEqual([
      { id: "role_changed:capo:task", type: "role_changed", roleKey: "capo", roleName: "Capo", field: "task", from: "Compito mio", to: "Nuovo" },
    ]);
    expect(computeUpdates({ base, current: [trole()], instance, skillVersions: noSkills })).toEqual([]);
  });

  it("skill aggiunta e tolta nel modello", () => {
    const base = [trole({ skills: ["vecchia.x"] })];
    const items = computeUpdates({
      base,
      current: [trole({ skills: ["nuova.y"] })],
      instance: base.map((r) => pin(r)),
      skillVersions: new Map([["vecchia.x", 1], ["nuova.y", 1]]),
    });
    expect(items).toEqual([
      { id: "skill_added:capo:nuova.y", type: "skill_added", roleKey: "capo", roleName: "Capo", skillCode: "nuova.y" },
      { id: "skill_removed:capo:vecchia.x", type: "skill_removed", roleKey: "capo", roleName: "Capo", skillCode: "vecchia.x" },
    ]);
  });

  it("skill con versione nuova → skill_version 2→3; istanza senza modello → solo skill_version", () => {
    const instance = [irole({ skills: [{ code: "a.b", version: 2 }] })];
    const expected = [
      { id: "skill_version:capo:a.b", type: "skill_version", roleKey: "capo", roleName: "Capo", skillCode: "a.b", fromVersion: 2, toVersion: 3 },
    ];
    expect(computeUpdates({ base: null, current: null, instance, skillVersions: new Map([["a.b", 3]]) })).toEqual(expected);
    expect(computeUpdates({ base: [trole({ skills: ["a.b"] })], current: [trole({ skills: ["a.b"] })], instance, skillVersions: new Map([["a.b", 3]]) })).toEqual(
      expected,
    );
  });
});

describe("applyUpdates", () => {
  let userId: number;
  let modelId: number;
  let appId: number;
  const ref = () => ({ appId, type: "wi", id: "1174" });
  const tr = (over: Partial<TemplateRole> = {}) => trole({ aiModelId: modelId, ...over });

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
    for (const code of ["sap.review", "sap.test"]) {
      const [skill] = await db.insert(skillsTable).values({ code, name: code, kind: "casello" }).returning();
      await db.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content: "istruzioni" });
    }
  });

  afterAll(async () => {
    await pool.query("TRUNCATE users, apps, ai_accounts, skills, team_templates, team_instances RESTART IDENTITY CASCADE");
  });

  const dev = (over: Partial<TemplateRole> = {}) => tr({ key: "dev", name: "Sviluppatore", isLead: false, ...over });

  it("applicazione parziale: la versione del modello resta finché restano voci del modello, poi passa alla corrente", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [tr({ skills: ["sap.review"] })] });
    const inst = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    await saveTemplate(userId, template.id, { name: "Sviluppo", roles: [tr({ name: "Coordinatore", skills: ["sap.review", "sap.test"] }), dev()] });
    await updateSkill("sap.review", { content: "v2" });

    const items = await getUpdates(inst.id);
    expect(items.map((i) => i.id)).toEqual(["role_changed:capo:name", "skill_added:capo:sap.test", "role_added:dev", "skill_version:capo:sap.review"]);

    const partial = await applyUpdates(userId, inst.id, ["role_changed:capo:name", "skill_version:capo:sap.review"]);
    expect(partial.template!.version).toBe(1);
    expect(partial.roles[0]).toMatchObject({ name: "Coordinatore" });
    expect(partial.roles[0]!.skills).toMatchObject([{ code: "sap.review", version: 2 }]);
    expect((await getUpdates(inst.id)).map((i) => i.id)).toEqual(["skill_added:capo:sap.test", "role_added:dev"]);

    const full = await applyUpdates(userId, inst.id, ["skill_added:capo:sap.test", "role_added:dev"]);
    expect(full.template!.version).toBe(2);
    expect(full.roles.map((r) => r.key)).toEqual(["capo", "dev"]);
    expect(full.roles[0]!.skills.map((s) => [s.code, s.version])).toEqual([
      ["sap.review", 2],
      ["sap.test", 1],
    ]);
    expect(await getUpdates(inst.id)).toEqual([]);
  });

  it("voce che toglierebbe l'unico capo → 400 e nessuna modifica", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [tr(), dev()] });
    const inst = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    await saveTemplate(userId, template.id, { name: "Sviluppo", roles: [tr({ isLead: false }), dev({ isLead: true })] });
    await expect(applyUpdates(userId, inst.id, ["role_changed:capo:isLead"])).rejects.toMatchObject({
      status: 400,
      message: "una squadra ha esattamente un capo",
    });
    const after = await getInstance(inst.id);
    expect(after.roles.find((r) => r.key === "capo")).toMatchObject({ isLead: true });
    expect(after.template!.version).toBe(1);
    // Insieme le due voci sono valide
    const both = await applyUpdates(userId, inst.id, ["role_changed:capo:isLead", "role_changed:dev:isLead"]);
    expect(both.roles.map((r) => [r.key, r.isLead])).toEqual([
      ["capo", false],
      ["dev", true],
    ]);
    expect(both.template!.version).toBe(2);
  });

  it("id non più valido (modello cambiato di nuovo) → 409 senza modifiche", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [tr()] });
    const inst = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    await saveTemplate(userId, template.id, { name: "Sviluppo", roles: [tr({ task: "Nuovo" })] });
    expect((await getUpdates(inst.id)).map((i) => i.id)).toEqual(["role_changed:capo:task"]);
    await saveTemplate(userId, template.id, { name: "Sviluppo", roles: [tr({ name: "Altro" })] });
    await expect(applyUpdates(userId, inst.id, ["role_changed:capo:task"])).rejects.toMatchObject({
      status: 409,
      message: "aggiornamenti cambiati: ricarica",
    });
    const after = await getInstance(inst.id);
    expect(after.roles[0]).toMatchObject({ task: "Coordina", name: "Capo" });
    expect(after.template!.version).toBe(1);
  });

  it("un modello salvato di nuovo senza cambiare nulla non propone voci; applicare una skill_version allinea la versione", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [tr({ skills: ["sap.review"] })] });
    const inst = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    await saveTemplate(userId, template.id, { name: "Sviluppo", roles: [tr({ skills: ["sap.review"] })] });
    expect(await getUpdates(inst.id)).toEqual([]);
    await updateSkill("sap.review", { content: "v2" });
    const applied = await applyUpdates(userId, inst.id, ["skill_version:capo:sap.review"]);
    expect(applied.template!.version).toBe(2);
  });

  it("istanza chiusa → 409 sia in lettura sia in applicazione; istanza inesistente → 404", async () => {
    const inst = await createInstance(userId, { name: "S", ref: ref(), roles: [{ ...tr(), skills: [{ code: "sap.review", version: 1 }], localSkills: [] }] });
    await updateSkill("sap.review", { content: "v2" });
    expect((await getUpdates(inst.id)).map((i) => i.id)).toEqual(["skill_version:capo:sap.review"]);
    await closeInstance(inst.id);
    await expect(getUpdates(inst.id)).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(applyUpdates(userId, inst.id, ["skill_version:capo:sap.review"])).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(getUpdates(999)).rejects.toBeInstanceOf(InstanceError);
  });

  it("le skill specializzate dell'istanza restano valide durante l'applicazione", async () => {
    const template = await createTemplate(userId, { name: "Sviluppo", roles: [tr()] });
    const inst = await createInstance(userId, { templateId: template.id, name: "S", ref: ref() });
    await saveInstance(userId, inst.id, {
      name: "S",
      roles: [{ ...tr(), skills: [], localSkills: ["spec.uno"] }],
      localSkills: [{ code: "spec.uno", name: "Uno", kind: "casello", content: "ok" }],
    });
    await saveTemplate(userId, template.id, { name: "Sviluppo", roles: [tr({ task: "Nuovo" })] });
    const applied = await applyUpdates(userId, inst.id, ["role_changed:capo:task"]);
    expect(applied.roles[0]).toMatchObject({ task: "Nuovo" });
    expect(applied.roles[0]!.skills.map((s) => s.code)).toEqual(["spec.uno"]);
  });
});
