import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, pendingActionsTable, teamCodeTasksTable, teamTasksTable, teamWorksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { listWorks, workSummary } from "./works";
import { WORK_INSTRUCTION, codeInstruction, mergeInstruction } from "./turn-runner";

// Vista del lavoro su branch unico per il capo (`leggi_piano`) e per la console (Postgres di prova)

let userId: number;
let instanceId: number;
const coder = () => nodeRole({ key: "dev", name: "Dev", runsOn: "cloud", code: "write" } as never);

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
  userId = await ensureUser("dev@localhost");
  instanceId = await seedNodeTeam({ userId, roles: [coder()], tasks: { t1: "dev", t2: "dev" } });
  await db.update(appsTable).set({ sourceType: "github", sourceRepo: "o/r", stagingBranch: "staging", stagingUrl: "https://prova.example" });
});
afterAll(async () => {
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
});

async function work(over: Partial<typeof teamWorksTable.$inferInsert> = {}) {
  const [w] = await db
    .insert(teamWorksTable)
    .values({ instanceId, number: 1, repo: "o/r", branch: `botcave/lavoro-${instanceId}-1`, baseBranch: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40), ...over })
    .returning();
  return w!;
}

describe("workSummary", () => {
  it("senza lavori: null", async () => {
    expect(await workSummary(instanceId)).toBeNull();
  });

  it("lavoro aperto: PR unite e compito in fila", async () => {
    const w = await work();
    await db.insert(teamCodeTasksTable).values([
      { instanceId, planTaskId: "t1", repo: "o/r", branch: "botcave/x-t1", baseBranch: w.branch, prNumber: 3, prState: "merged", workId: w.id },
      { instanceId, planTaskId: "t2", repo: "o/r", branch: "botcave/x-t2", baseBranch: w.branch, prNumber: 4, prState: "open", workId: w.id },
    ]);
    expect(await workSummary(instanceId)).toEqual({ numero: 1, stato: "open", branch: w.branch, prUnite: 1, compitoInFila: "t2" });
  });

  it("compito con codice in corso senza PR: è quello in fila", async () => {
    await work();
    await db.insert(teamTasksTable).values({ instanceId, planTaskId: "t2", roleKey: "dev", instructions: "", status: "running" });
    expect((await workSummary(instanceId))!.compitoInFila).toBe("t2");
  });
});

describe("listWorks", () => {
  it("ultimi lavori con PR unite, voce e PR di rilascio, indirizzo di prova", async () => {
    await work({ status: "released", finishedAt: new Date() });
    const [item] = await db
      .insert(pendingActionsTable)
      .values({ userId, number: 7, kind: "release", recipient: "o/r", summary: "Porta in produzione", argsEnc: "x", argsPublic: {}, teamInstanceId: instanceId } as never)
      .returning();
    await work({ number: 2, branch: `botcave/lavoro-${instanceId}-2`, status: "releasing", pendingActionId: item!.id, releasePrNumber: 9, releasePrUrl: "https://gh/pr/9" });
    const rows = await listWorks(instanceId);
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ status: "releasing", releaseActionNumber: 7, releasePrNumber: 9, releasePrUrl: "https://gh/pr/9", mergedPulls: 0, stagingUrl: "https://prova.example", repo: "o/r" });
    expect(rows[1]!.finishedAt).not.toBeNull();
  });
});

describe("prompt del capo", () => {
  it("con un ruolo che scrive codice: istruzioni del lavoro su branch unico al posto di quelle del merge", () => {
    const text = codeInstruction([coder() as never]);
    expect(text).toBe(WORK_INSTRUCTION);
    expect(text).toContain("chiudi_lavoro");
    expect(text).toContain("botcave/**");
    expect(text).toContain("Porta in produzione");
  });

  it("senza ruoli che scrivono codice: regola del merge di sempre", () => {
    const roles = [nodeRole({ key: "x", runsOn: "cloud", code: "read" } as never)];
    expect(codeInstruction(roles as never)).toBe(mergeInstruction(roles as never));
  });
});

void eq;
