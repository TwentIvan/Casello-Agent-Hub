import { appsTable, db, releaseTestsTable, teamInstancesTable, teamWorksTable } from "@workspace/db";

// Collaudo di prova: App con repository e installazione, squadra, lavoro e riga di `release_tests`.
export async function seedReleaseTest(
  opts: { status?: "queued" | "dispatching" | "running"; repo?: string | null; installationId?: number | null; recipe?: unknown; slug?: string } = {},
): Promise<{ testId: number; appId: number }> {
  const slug = opts.slug ?? `app-${Math.random().toString(36).slice(2, 8)}`;
  const [app] = await db
    .insert(appsTable)
    .values({
      name: slug,
      slug,
      baseUrl: `https://${slug}.example.com`,
      sourceType: "github",
      sourceRepo: opts.repo === undefined ? "ivan/mister" : opts.repo,
      sourceInstallationId: opts.installationId === undefined ? 7 : opts.installationId,
      testRecipe: opts.recipe ?? null,
    })
    .returning();
  const [instance] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra", refAppId: app!.id, refType: "piano", refId: "1", refTitle: "Piano", roles: [] })
    .returning();
  const [work] = await db
    .insert(teamWorksTable)
    .values({ instanceId: instance!.id, number: 1, repo: "ivan/mister", branch: "botcave/lavoro-1-1", baseBranch: "main", baseSha: "abc1234" })
    .returning();
  const [test] = await db
    .insert(releaseTestsTable)
    .values({ appId: app!.id, workId: work!.id, instanceId: instance!.id, sha: "def5678", status: opts.status ?? "dispatching" })
    .returning();
  return { testId: test!.id, appId: app!.id };
}
