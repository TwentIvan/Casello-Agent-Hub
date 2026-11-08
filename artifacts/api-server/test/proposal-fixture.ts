import { db, agentsTable, runsTable } from "@workspace/db";
import { enqueueProposal } from "../src/lib/actions/queue";

// Proposta di prova con tre passi sullo stesso tool: p3 usa `{{p2.id}}`, così escludere p2 salta anche p3.

export const TEST_PROPOSAL_STEPS = [
  { key: "p1", args: { id: "1" }, summary: "Crea il progetto" },
  { key: "p2", args: { id: "2" }, summary: "Crea il compito" },
  { key: "p3", args: { id: "{{p2.id}}" }, summary: "Commenta il compito" },
] as const;

export async function queueTestProposal(opts: { userId: number; appId: number; toolId: number; toolName: string }): Promise<number> {
  const [agent] = await db.insert(agentsTable).values({ appId: opts.appId, name: `Area ${Date.now()}-${Math.random()}`, role: "area" }).returning();
  const [run] = await db.insert(runsTable).values({ agentId: agent!.id, input: "x" }).returning();
  const steps = TEST_PROPOSAL_STEPS.map((s) => ({ key: s.key, toolName: opts.toolName, args: { ...s.args }, summary: s.summary }));
  const out = await enqueueProposal({
    userId: opts.userId,
    appId: opts.appId,
    agentId: agent!.id,
    runId: run!.id,
    recipient: "Mister",
    proposal: { title: "Nuovo progetto", reason: "Richiesta del cliente", steps },
    publicProposal: { title: "Nuovo progetto", reason: "Richiesta del cliente", steps },
    steps: steps.map((s, i) => ({ key: s.key, position: i, toolId: opts.toolId, summary: s.summary })),
  });
  if (!out.ok) throw new Error(out.message);
  return out.number;
}
