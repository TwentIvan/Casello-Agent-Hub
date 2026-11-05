import { eq } from "drizzle-orm";
import {
  appsTable,
  db,
  skillVersionsTable,
  skillsTable,
  teamInstanceSkillsTable,
  teamInstancesTable,
  usersTable,
  type InstanceRoleData,
} from "@workspace/db";
import { writePlanVersion, type PlanTask } from "../src/lib/teams/plan";

// Squadre con ruoli `node` per i test del protocollo dei nodi: utente, app di riferimento, skill del catalogo
// di tipo `node` (il contenuto è il nome della skill sul nodo), PLAN approvato.

export async function ensureUser(email: string): Promise<number> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (user) return user.id;
  const [created] = await db.insert(usersTable).values({ email, name: email }).returning();
  return created!.id;
}

/** Skill del catalogo alla versione 1 (per `node`, `content` è il nome della skill sul nodo). */
export async function catalogSkill(code: string, kind: "casello" | "node", content: string): Promise<void> {
  const [skill] = await db.insert(skillsTable).values({ code, name: code, kind }).returning();
  await db.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content });
}

export const nodeRole = (over: Partial<InstanceRoleData> = {}): InstanceRoleData => ({
  key: "operaio",
  name: "Operaio SAP",
  task: "Sviluppa in ABAP.",
  isLead: false,
  runsOn: "node",
  aiModelId: null,
  tools: [],
  skills: [],
  localSkills: [],
  ...over,
});

const leadRole = (): InstanceRoleData => ({ ...nodeRole(), key: "capo", name: "Capo", isLead: true, runsOn: "cloud", task: "Coordina." });

const planTask = (id: string, roleKey: string): PlanTask => ({
  id,
  title: `Compito ${id}`,
  roleKey,
  instructions: `Istruzioni di ${id}`,
  status: "planned",
  outcome: null,
});

export interface SeedTeamOptions {
  userId: number;
  roles?: InstanceRoleData[];
  /** Compiti del PLAN: id → chiave del ruolo (default: t1 → operaio). */
  tasks?: Record<string, string>;
  status?: "draft" | "active" | "closed";
  monthlyBudgetUsd?: string;
  nodeWorkspace?: string | null;
  localSkills?: { code: string; kind: "casello" | "node"; content: string }[];
}

/** Squadra (attiva di default, attivata da `userId`) con il PLAN approvato. */
export async function seedNodeTeam(opts: SeedTeamOptions): Promise<number> {
  let [app] = await db.select().from(appsTable).where(eq(appsTable.slug, "hub-up"));
  if (!app) [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "http://hub.example" }).returning();
  const roles = opts.roles ?? [nodeRole()];
  const [row] = await db
    .insert(teamInstancesTable)
    .values({
      name: "Squadra WI",
      refAppId: app!.id,
      refType: "wi",
      refId: "1174",
      refTitle: "WI 1174",
      status: opts.status ?? "active",
      roles: [leadRole(), ...roles],
      createdBy: opts.userId,
      activatedBy: opts.userId,
      nodeWorkspace: opts.nodeWorkspace === undefined ? "SAP/AIMAG/WI_1174" : opts.nodeWorkspace,
      ...(opts.monthlyBudgetUsd ? { monthlyBudgetUsd: opts.monthlyBudgetUsd } : {}),
    })
    .returning();
  for (const s of opts.localSkills ?? []) {
    await db.insert(teamInstanceSkillsTable).values({ instanceId: row!.id, code: s.code, name: s.code, kind: s.kind, content: s.content });
  }
  const tasks = opts.tasks ?? { t1: "operaio" };
  await writePlanVersion(
    row!.id,
    {
      objective: "Chiudere il WI",
      constraints: ["Niente trasporti in produzione"],
      openPoints: ["Quale società?"],
      manualActions: [{ id: "m1", text: "Aprire la CR", done: true, doneAt: new Date().toISOString() }],
      tasks: Object.entries(tasks).map(([id, roleKey]) => planTask(id, roleKey)),
    },
    "approved",
  );
  return row!.id;
}
