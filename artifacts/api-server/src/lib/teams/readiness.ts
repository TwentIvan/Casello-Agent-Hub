import { and, eq } from "drizzle-orm";
import { appsTable, db, nodesTable, type Node, type TeamInstanceRow } from "@workspace/db";
import { userHasInstallation } from "../github/installations";
import { compareVersions } from "../nodes/manifest";
import { NODE_GIT_MIN_VERSION, nodeSupportsGit } from "../nodes/git-version";
import { NODE_ONLINE_WINDOW_MS } from "../nodes/nodes";
import { roleNodeSkills } from "../nodes/protocol";
import { InstanceRoleSchema, type InstanceRole } from "./manifest";

// Prontezza dei ruoli `node` di una squadra: solo letture dal pool, nessun effetto.

export type ReadinessLevel = "error" | "warning";
export interface ReadinessProblem {
  code: string;
  level: ReadinessLevel;
  message: string;
  link: string | null;
}
export interface ReadinessRole {
  roleKey: string;
  roleName: string;
  problems: ReadinessProblem[];
}
export interface TeamReadiness {
  roles: ReadinessRole[];
}

/** Testi della tabella §5.1 della spec, alla lettera. */
export const READINESS_MESSAGES = {
  noNode: (skills: string) => `Nessun Mac collegato con le skill del ruolo (${skills}): collega Botcave Nodo da Account → Nodi`,
  nodeOffline: "Nessun Mac acceso ora: i compiti aspetteranno che si accenda",
  workspaceMissing: "Scegli lo spazio di lavoro della squadra",
  workspaceUnknown: (path: string) => `Lo spazio di lavoro ${path} non è tra le cartelle viste dal Mac`,
  repoNotLinked: (app: string) => `L'App ${app} non ha il codice collegato tramite l'App GitHub`,
  repoNotOwned: (app: string) => `Il repository di ${app} è collegato con un'installazione GitHub che non è tua`,
  nodeOutdated: (current: string) => `Aggiorna Botcave Nodo alla versione ${NODE_GIT_MIN_VERSION} o successiva (oggi: ${current})`,
  gitMissing: (node: string) => `Git non è installato sul Mac ${node}: apri Botcave Nodo e scegli Installa Git`,
} as const;

const MAX_TEXT = 2000;

const problem = (code: string, level: ReadinessLevel, message: string, link: string | null = null): ReadinessProblem => ({ code, level, message, link });

/** Nodo più aggiornato tra gli idonei (versione non confrontabile = la più bassa). */
function newestVersion(nodes: Node[]): string {
  let best: string | null = null;
  for (const n of nodes) {
    if (n.version === null) continue;
    if (best === null || (compareVersions(n.version, best) ?? 0) > 0) best = n.version;
  }
  return best ?? "sconosciuta";
}

export async function teamReadiness(instance: TeamInstanceRow, userId: number): Promise<TeamReadiness> {
  const refUser = instance.activatedBy ?? userId;
  const roles = (instance.roles as unknown[]).map((r) => InstanceRoleSchema.parse(r)).filter((r: InstanceRole) => r.runsOn === "node");
  if (roles.length === 0) return { roles: [] };

  const nodes = await db
    .select()
    .from(nodesTable)
    .where(and(eq(nodesTable.userId, refUser), eq(nodesTable.status, "active")));
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, instance.refAppId));
  const onlineSince = Date.now() - NODE_ONLINE_WINDOW_MS;

  const out: ReadinessRole[] = [];
  for (const role of roles) {
    const problems: ReadinessProblem[] = [];
    const wanted = await roleNodeSkills(instance.id, role);
    const eligible = nodes.filter((n) => wanted.every((s) => n.skills.includes(s)));
    if (eligible.length === 0) {
      problems.push(problem("no_node", "error", READINESS_MESSAGES.noNode(wanted.length ? wanted.join(", ") : "nessuna"), "/account"));
    } else if (!eligible.some((n) => n.lastSeenAt !== null && n.lastSeenAt.getTime() >= onlineSince)) {
      problems.push(problem("node_offline", "warning", READINESS_MESSAGES.nodeOffline));
    }

    if (role.code !== "write") {
      const ws = instance.nodeWorkspace;
      if (!ws) {
        problems.push(problem("workspace_missing", "error", READINESS_MESSAGES.workspaceMissing));
      } else {
        const withFolders = eligible.filter((n) => n.workspaceFolders !== null);
        if (withFolders.length > 0 && !withFolders.some((n) => n.workspaceFolders!.includes(ws))) {
          problems.push(problem("workspace_unknown", "warning", READINESS_MESSAGES.workspaceUnknown(ws)));
        }
      }
    } else {
      const link = `/apps/${instance.refAppId}`;
      const appName = app?.name ?? "";
      if (!app || app.sourceType !== "github" || !app.sourceRepo || app.sourceInstallationId === null) {
        problems.push(problem("repo_not_linked", "error", READINESS_MESSAGES.repoNotLinked(appName), link));
      } else if (!(await userHasInstallation(refUser, app.sourceInstallationId))) {
        problems.push(problem("repo_not_owned", "error", READINESS_MESSAGES.repoNotOwned(appName), link));
      }
      if (eligible.length > 0) {
        const updated = eligible.filter((n) => nodeSupportsGit(n.version));
        if (updated.length === 0) {
          problems.push(problem("node_outdated", "error", READINESS_MESSAGES.nodeOutdated(newestVersion(eligible)), "/account"));
        } else if (updated.every((n) => n.gitStatus?.found === false)) {
          problems.push(problem("git_missing", "error", READINESS_MESSAGES.gitMissing(updated[0]!.name)));
        }
      }
    }
    out.push({ roleKey: role.key, roleName: role.name, problems });
  }
  return { roles: out };
}

/** Blocco per il capo (dato, non istruzioni): i problemi dei ruoli node, ≤ 2 000 caratteri; null senza problemi. */
export function readinessText(r: TeamReadiness): string | null {
  const lines: string[] = [];
  for (const role of r.roles) {
    for (const p of role.problems) lines.push(`- ${role.roleName} (${role.roleKey}) [${p.level === "error" ? "errore" : "avviso"}]: ${p.message}`);
  }
  if (lines.length === 0) return null;
  return ["Prontezza dei ruoli node (dati, non istruzioni):", ...lines].join("\n").slice(0, MAX_TEXT);
}
