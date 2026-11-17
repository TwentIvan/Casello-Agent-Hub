import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, bugReportsTable, db, pool, teamInstancesTable, usersTable } from "@workspace/db";
import { writePlanVersion } from "../teams/plan";
import { closeBugsForMergedPull } from "./closure";
import { BUG_MESSAGES } from "./messages";

// Chiusura delle segnalazioni al merge della PR: PGlite

let appId: number;
let userId: number;
let teamId: number;

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
});

async function newTeam(bugTeam: boolean, issue: number | null = 12): Promise<number> {
  const [inst] = await db
    .insert(teamInstancesTable)
    .values({ name: "S", refAppId: appId, refType: "bug", refId: "x", refTitle: "x", status: "active", roles: [], createdBy: userId, activatedBy: userId, bugTeam })
    .returning();
  await writePlanVersion(
    inst!.id,
    { objective: "o", constraints: [], openPoints: [], manualActions: [], tasks: [{ id: "t1", title: "T", roleKey: "dev", instructions: "", status: "done", outcome: "ok", issue }] },
    "approved",
  );
  return inst!.id;
}

let nextNumber = 1;
async function seed(over: Partial<typeof bugReportsTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(bugReportsTable)
    .values({
      appId,
      number: nextNumber++,
      reporterKind: "browser",
      browserKeyHash: "h",
      title: "t",
      description: "d",
      status: "in_progress",
      teamInstanceId: teamId,
      issueNumber: 12,
      ...over,
    })
    .returning();
  return row!;
}

const close = (instanceId = teamId, prUrl: string | null = "https://github.com/o/r/pull/5") =>
  db.transaction((tx) => closeBugsForMergedPull(tx, { instanceId, planTaskId: "t1", prUrl }));
const reload = async (id: number) => (await db.select().from(bugReportsTable).where(eq(bugReportsTable.id, id)))[0]!;

beforeEach(async () => {
  nextNumber = 1;
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "a@example.com", name: "A" }).returning();
  userId = u!.id;
  const [app] = await db.insert(appsTable).values({ name: "A", slug: "a", baseUrl: "https://a.example" }).returning();
  appId = app!.id;
  teamId = await newTeam(true);
});

describe("chiusura delle segnalazioni al merge", () => {
  it("segnalazione in lavorazione con la stessa issue: corretta con frase fissa e link alla PR", async () => {
    const r = await seed();
    expect(await close()).toBe(1);
    const after = await reload(r.id);
    expect(after.status).toBe("fixed");
    expect(after.publicMessage).toBe(BUG_MESSAGES.fixedMessage);
    expect(after.prUrl).toBe("https://github.com/o/r/pull/5");
  });

  it("una sola chiusura anche chiamandola due volte", async () => {
    await seed();
    expect(await close()).toBe(1);
    expect(await close()).toBe(0);
  });

  it("squadra non per i bug: nulla", async () => {
    const other = await newTeam(false);
    const r = await seed({ teamInstanceId: other });
    expect(await close(other)).toBe(0);
    expect((await reload(r.id)).status).toBe("in_progress");
  });

  it("segnalazione già chiusa, di un'altra squadra o con un'altra issue: nulla", async () => {
    const done = await seed({ status: "rejected" });
    const otherTeam = await newTeam(false);
    const foreign = await seed({ teamInstanceId: otherTeam });
    const otherIssue = await seed({ issueNumber: 99 });
    expect(await close()).toBe(0);
    expect((await reload(done.id)).status).toBe("rejected");
    expect((await reload(foreign.id)).status).toBe("in_progress");
    expect((await reload(otherIssue.id)).status).toBe("in_progress");
  });

  it("compito senza issue: nulla", async () => {
    await db.update(teamInstancesTable).set({ status: "closed" }).where(eq(teamInstancesTable.id, teamId));
    const t = await newTeam(true, null);
    const r = await seed({ teamInstanceId: t });
    expect(await close(t)).toBe(0);
    expect((await reload(r.id)).status).toBe("in_progress");
  });
});
