import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, appsTable, githubInstallationsTable, nodesTable, teamInstancesTable, usersTable } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { READINESS_MESSAGES, readinessText, teamReadiness } from "./readiness";

// Prontezza dei ruoli node (Postgres di prova)

let userId: number;

async function instance(id: number) {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, id));
  return row!;
}
async function addNode(over: Partial<typeof nodesTable.$inferInsert> = {}) {
  const [n] = await db
    .insert(nodesTable)
    .values({ userId, name: `mac-${Math.random()}`, status: "active", version: "0.4.0", skills: ["sap:abap-developer"], lastSeenAt: new Date(), ...over })
    .returning();
  return n!;
}
async function linkApp(opts: { installation?: boolean; owned?: boolean } = {}) {
  const [app] = await db.select().from(appsTable);
  await db
    .update(appsTable)
    .set({ sourceType: "github", sourceRepo: "o/r", sourceInstallationId: opts.installation === false ? null : 77 })
    .where(eq(appsTable.id, app!.id));
  if (opts.owned !== false && opts.installation !== false) {
    await db.insert(githubInstallationsTable).values({ userId, installationId: 77, accountLogin: "o", accountType: "User", repositorySelection: "all" } as never);
  }
  return app!;
}
const codes = async (id: number, key = "operaio") => {
  const r = await teamReadiness(await instance(id), userId);
  return r.roles.find((x) => x.roleKey === key)?.problems.map((p) => p.code);
};

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances, nodes, github_installations RESTART IDENTITY CASCADE");
  userId = await ensureUser("dev@localhost");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
});
afterAll(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances, nodes, github_installations RESTART IDENTITY CASCADE");
});

const withSkill = (over = {}) => nodeRole({ skills: [{ code: "sap-abap", version: 1 }], ...over });

describe("teamReadiness", () => {
  it("solo i ruoli node; ruolo cloud assente dall'elenco", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill()] });
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles.map((x) => x.roleKey)).toEqual(["operaio"]);
  });

  it("no_node: nessun nodo con le skill", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill()] });
    await addNode({ skills: [] });
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles[0]!.problems[0]).toEqual({
      code: "no_node",
      level: "error",
      message: "Nessun Mac collegato con le skill del ruolo (sap:abap-developer): collega Botcave Nodo da Account → Nodi",
      link: "/account",
    });
  });

  it("node_offline: nodo visto 3 minuti fa", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill()], nodeWorkspace: "A/B" });
    await addNode({ lastSeenAt: new Date(Date.now() - 3 * 60_000) });
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles[0]!.problems).toEqual([
      { code: "node_offline", level: "warning", message: "Nessun Mac acceso ora: i compiti aspetteranno che si accenda", link: null },
    ]);
  });

  it("workspace_missing", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill()], nodeWorkspace: null });
    await addNode();
    expect(await codes(id)).toEqual(["workspace_missing"]);
  });

  it("workspace_unknown solo se un nodo ha mandato cartelle senza il percorso", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill()], nodeWorkspace: "A/B" });
    const n = await addNode({ workspaceFolders: null });
    expect(await codes(id)).toEqual([]);
    await db.update(nodesTable).set({ workspaceFolders: ["X"] }).where(eq(nodesTable.id, n.id));
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles[0]!.problems).toEqual([
      { code: "workspace_unknown", level: "warning", message: "Lo spazio di lavoro A/B non è tra le cartelle viste dal Mac", link: null },
    ]);
    await db.update(nodesTable).set({ workspaceFolders: ["A/B"] }).where(eq(nodesTable.id, n.id));
    expect(await codes(id)).toEqual([]);
  });

  it("ruolo con codice: repo_not_linked", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill({ code: "write" })] });
    await addNode();
    const r = await teamReadiness(await instance(id), userId);
    const [app] = await db.select().from(appsTable);
    expect(r.roles[0]!.problems).toEqual([
      { code: "repo_not_linked", level: "error", message: "L'App The Hub Up non ha il codice collegato tramite l'App GitHub", link: `/apps/${app!.id}` },
    ]);
  });

  it("ruolo con codice: repo_not_owned", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill({ code: "write" })] });
    await addNode();
    const app = await linkApp({ owned: false });
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles[0]!.problems).toEqual([
      { code: "repo_not_owned", level: "error", message: "Il repository di The Hub Up è collegato con un'installazione GitHub che non è tua", link: `/apps/${app.id}` },
    ]);
  });

  it("node_outdated con la versione di oggi", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill({ code: "write" })] });
    await addNode({ version: "0.3.0" });
    await linkApp();
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles[0]!.problems).toEqual([
      { code: "node_outdated", level: "error", message: "Aggiorna Botcave Nodo alla versione 0.4.0 o successiva (oggi: 0.3.0)", link: "/account" },
    ]);
  });

  it("git_missing solo con found: false, non con stato assente", async () => {
    const id = await seedNodeTeam({ userId, roles: [withSkill({ code: "write" })] });
    const n = await addNode({ name: "Mac di Ivan", gitStatus: null });
    await linkApp();
    expect(await codes(id)).toEqual([]);
    await db.update(nodesTable).set({ gitStatus: { found: false, version: null } }).where(eq(nodesTable.id, n.id));
    const r = await teamReadiness(await instance(id), userId);
    expect(r.roles[0]!.problems).toEqual([
      { code: "git_missing", level: "error", message: "Git non è installato sul Mac Mac di Ivan: apri Botcave Nodo e scegli Installa Git", link: null },
    ]);
    await db.update(nodesTable).set({ gitStatus: { found: true, version: "2.4" } }).where(eq(nodesTable.id, n.id));
    expect(await codes(id)).toEqual([]);
  });

  it("utente di riferimento = activated_by se attivata", async () => {
    const other = await ensureUser("altro@localhost");
    const id = await seedNodeTeam({ userId, roles: [withSkill()], nodeWorkspace: "A" });
    await addNode();
    const row = await instance(id);
    expect((await teamReadiness(row, other)).roles[0]!.problems).toEqual([]);
    await db.update(teamInstancesTable).set({ activatedBy: null, status: "draft" }).where(eq(teamInstancesTable.id, id));
    expect((await teamReadiness(await instance(id), other)).roles[0]!.problems.map((p) => p.code)).toEqual(["no_node"]);
    void usersTable;
  });
});

describe("readinessText", () => {
  it("null senza problemi, tronca a 2 000", () => {
    expect(readinessText({ roles: [{ roleKey: "a", roleName: "A", problems: [] }] })).toBeNull();
    const long = { roles: [{ roleKey: "a", roleName: "A", problems: [{ code: "x", level: "error" as const, message: "m".repeat(3000), link: null }] }] };
    const t = readinessText(long)!;
    expect(t.length).toBeLessThanOrEqual(2000);
    expect(t).toContain("A");
    expect(READINESS_MESSAGES.noNode("x")).toContain("x");
  });
});
