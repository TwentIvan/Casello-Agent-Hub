import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appToolsTable, appsTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { TeamSnapshot } from "./context";
import { TEAM_CHAT_TOOLS, TeamChatToolRunner } from "./tools";

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

let toolId: number;
let foreignToolId: number;

const snapshot = (): TeamSnapshot => ({
  id: 1,
  name: "Squadra",
  status: "draft",
  ref: { appName: "Hub", type: "wi", id: "1", title: "Fix" },
  template: null,
  roles: [
    {
      key: "dev",
      name: "Sviluppatore",
      task: "Sviluppa",
      isLead: true,
      runsOn: "cloud",
      modelName: null,
      tools: [{ id: toolId, name: "crea_ordine", appName: "Hub", description: null, level: "L2", available: true }],
      skills: [
        { code: "sap.review", name: "Review", kind: "casello", version: 3, local: false, content: "Testo della review" },
        { code: "ruolo-dev", name: "Istruzioni", kind: "casello", version: null, local: true, content: "Manuale" },
      ],
    },
  ],
  localSkills: [{ code: "ruolo-dev", name: "Istruzioni", kind: "casello", content: "Manuale" }],
  plan: null,
});

const call = (name: string, args: unknown, id = "c") => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const MD = "---\nname: dev\ndescription: Sviluppo\n---\n# Dev\n";

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  const [app] = await db.insert(appsTable).values({ name: "Hub", slug: "hub", baseUrl: "https://segreto.example", serviceSecretEnc: encryptSecret("SEGRETO") }).returning();
  const [tool] = await db
    .insert(appToolsTable)
    .values({
      appId: app!.id,
      name: "crea_ordine",
      kind: "http",
      status: "active",
      level: "L2",
      definition: { method: "POST", path: "/ordini", paramLocations: { pin: "body", nota: "body" } },
      paramsSchema: {
        type: "object",
        properties: {
          pin: { type: "string", "x-sensitive": true, default: "PIN-SEGRETO", description: "pin 1234" },
          nota: { type: "string" },
          scelta: { anyOf: [{ type: "object", properties: { token: { type: "string", "x-sensitive": true, default: "TOK-ANYOF", examples: ["TOK-ESEMPIO"] } } }, { type: "null" }] },
          tutti: { allOf: [{ type: "object", properties: { chiave: { type: "string", "x-sensitive": true, default: "CHIAVE-ALLOF" } } }] },
          uno: { oneOf: [{ type: "string", "x-sensitive": true, examples: ["ONEOF-SEGRETO"] }] },
          mappa: { type: "object", additionalProperties: { type: "string", "x-sensitive": true, default: "ADDPROP-SEGRETO" } },
          rif: { $ref: "#/$defs/cred" },
        },
        $defs: { cred: { type: "string", "x-sensitive": true, default: "DEFS-SEGRETO" } },
        definitions: { vecchia: { type: "string", "x-sensitive": true, default: "DEFINITIONS-SEGRETO" } },
      },
    })
    .returning();
  toolId = tool!.id;
  const [other] = await db.insert(appToolsTable).values({ appId: app!.id, name: "altro", kind: "http", status: "active", level: "L0", definition: {} }).returning();
  foreignToolId = other!.id;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

describe("strumenti di Lucius sulla squadra", () => {
  it("elenco degli strumenti, con quelli di memoria", () => {
    expect(TEAM_CHAT_TOOLS.map((t) => t.function.name)).toEqual([
      "leggi_squadra",
      "leggi_skill",
      "leggi_strumento",
      "proponi_identita",
      "proponi_istruzioni",
      "ricorda",
      "aggiorna_appunto",
      "dimentica",
      "cerca_nello_storico",
    ]);
  });

  it("leggi_squadra e leggi_skill", async () => {
    const r = new TeamChatToolRunner(1, 1, snapshot());
    expect(await r.run(call("leggi_squadra", {}))).toContain("Sviluppatore");
    expect(JSON.parse(await r.run(call("leggi_skill", { code: "sap.review" })))).toEqual({
      ok: true,
      result: { code: "sap.review", name: "Review", kind: "casello", version: 3, local: false, content: "Testo della review" },
    });
    expect(JSON.parse(await r.run(call("leggi_skill", { code: "boh" })))).toEqual({ ok: false, error: "skill boh non presente nella squadra" });
  });

  it("leggi_strumento oscura i parametri x-sensitive e legge solo gli strumenti della squadra", async () => {
    const r = new TeamChatToolRunner(1, 1, snapshot());
    const out = await r.run(call("leggi_strumento", { id: toolId }));
    expect(out).toContain("crea_ordine");
    expect(out).toContain("nota");
    expect(out).not.toContain("PIN-SEGRETO");
    expect(out).not.toContain("1234");
    for (const secret of ["TOK-ANYOF", "TOK-ESEMPIO", "CHIAVE-ALLOF", "ONEOF-SEGRETO", "ADDPROP-SEGRETO", "DEFS-SEGRETO", "DEFINITIONS-SEGRETO"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("scelta");
    expect(out).not.toContain("segreto.example");
    expect(JSON.parse(await r.run(call("leggi_strumento", { id: foreignToolId })))).toEqual({ ok: false, error: "strumento non presente nella squadra" });
  });

  it("proposte: ruolo inesistente, frontmatter mancante, limiti di lunghezza; le valide restano in memoria", async () => {
    const r = new TeamChatToolRunner(1, 1, snapshot());
    expect(JSON.parse(await r.run(call("proponi_identita", { roleKey: "tester", testo: "x", motivazione: "y" })))).toEqual({ ok: false, error: "ruolo tester inesistente" });
    expect(JSON.parse(await r.run(call("proponi_istruzioni", { roleKey: "dev", markdown: "# Dev", motivazione: "y" })))).toEqual({
      ok: false,
      error: "il file deve iniziare con il frontmatter del ruolo",
    });
    expect(JSON.parse(await r.run(call("proponi_identita", { roleKey: "dev", testo: "x".repeat(8_001), motivazione: "y" }))).ok).toBe(false);
    expect(JSON.parse(await r.run(call("proponi_identita", { roleKey: "dev", testo: "x", motivazione: "y".repeat(1_001) }))).ok).toBe(false);
    expect(JSON.parse(await r.run(call("proponi_istruzioni", { roleKey: "dev", markdown: MD + "z".repeat(20_000), motivazione: "y" }))).ok).toBe(false);
    expect(JSON.parse(await r.run(call("proponi_istruzioni", { roleKey: "dev", markdown: MD, motivazione: "serve" }))).ok).toBe(true);
    expect(JSON.parse(await r.run(call("proponi_identita", { roleKey: "dev", testo: "Nuova", motivazione: "serve" }))).ok).toBe(true);
    expect(r.proposals).toEqual([
      { kind: "role_instructions", roleKey: "dev", payload: { markdown: MD }, rationale: "serve" },
      { kind: "role_identity", roleKey: "dev", payload: { text: "Nuova" }, rationale: "serve" },
    ]);
    expect(await r.run(call("leggi_skill", "non json"))).toContain("argomenti non validi");
  });
});
