// Servizio della sintesi dell'architettura delle App: idoneità (Responsabile, pagatore e modello cloud), controllo
// dello SHA del branch base, presa in carico, generazione ed esito. Una sola generazione per App (UPDATE
// condizionato). La sintesi precedente resta finché una nuova non riesce. Nei log solo id, sha a 7, conteggi ed esito.

import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, appArchitectureRunsTable, appArchitectureTable, appsTable, type Agent, type App, type AppArchitecture } from "@workspace/db";
import { resolveModel, ModelAccessError } from "../ai/executor";
import { SourceError } from "../architect/sources";
import { runBudgetBlock } from "../budget";
import { CODE_MESSAGES } from "../code-reader/messages";
import { codeReaderGithubConfig } from "../code-reader/source-cache";
import { productLead } from "../escalation";
import { GithubError, installationToken } from "../github/app";
import { fetchBranchSha } from "../github/commit";
import { userHasInstallation } from "../github/installations";
import { logger } from "../logger";
import { usageCost } from "../loop-wiring";
import { ArchitectureError, collectMaterials } from "./collect";
import { generateSummary } from "./generate";
import { ARCH_MESSAGES } from "./messages";

type Refresh = App["architectureRefresh"];
type Interval = Exclude<Refresh, "off">;

/** Intervallo minimo tra due generazioni per frequenza. */
export const REFRESH_INTERVAL_MS: Record<Interval, number> = {
  hourly: 3_600_000,
  "6h": 6 * 3_600_000,
  daily: 24 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
};

const BACKOFF_BASE_MS = 30 * 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;
/** Versioni (righe con `summary`) conservate per App; oltre si svuota il testo, la riga resta per la spesa. */
export const ARCH_VERSIONS_KEPT = 20;

/** Attesa dopo `errors` errori di fila già registrati: `min(30 min × 2^errori, 24 h)`. */
export function backoffMs(errors: number): number {
  const n = Math.max(0, Math.min(errors, 30));
  return Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS);
}

/**
 * Va rigenerata: SHA letto diverso da quello sintetizzato (o prima sintesi) **e** (richiesta esplicita o prima
 * generazione o intervallo trascorso) **e** nessun backoff in corso. Con `off` solo una richiesta esplicita.
 */
export function isDue(
  row: Pick<AppArchitecture, "sha" | "seenSha" | "forceRequested" | "generatedAt" | "nextAttemptAt">,
  refresh: Refresh,
  now: Date,
): boolean {
  if (!row.seenSha || row.seenSha === row.sha) return false;
  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return false;
  if (row.forceRequested) return true;
  if (refresh === "off") return false;
  if (!row.generatedAt) return true;
  return row.generatedAt.getTime() + REFRESH_INTERVAL_MS[refresh] <= now.getTime();
}

// --- idoneità ---------------------------------------------------------------------------------------------------

export type Eligibility = { ok: true; lead: Agent; payerUserId: number; aiModelId: number } | { ok: false; reason: string };

function hasGithubInstallation(app: App): boolean {
  return app.sourceType === "github" && !!app.sourceRepo && app.sourceInstallationId != null;
}

/** Messaggio fisso di un modello non usabile (mai il testo del provider). */
function modelError(err: unknown): string {
  return err instanceof ModelAccessError ? err.message : ARCH_MESSAGES.internal;
}

/**
 * App idonea alla sintesi: codice da GitHub tramite installazione, Responsabile `active` con modello. Pagatore =
 * proprietario dell'account del modello; un modello «Claude Code (nodo)» passa al ripiego cloud dell'account (un
 * lavoro di sfondo non sveglia il Mac), altrimenti `nodeNoFallback`.
 */
export async function architectureEligibility(app: App): Promise<Eligibility> {
  if (!hasGithubInstallation(app)) return { ok: false, reason: ARCH_MESSAGES.noGithub };
  const lead = await productLead(app.id);
  if (!lead || lead.aiModelId == null) return { ok: false, reason: ARCH_MESSAGES.noLead };
  let resolved;
  try {
    resolved = await resolveModel(lead.aiModelId, { userId: null, mustOwn: false });
  } catch (err) {
    return { ok: false, reason: modelError(err) };
  }
  const payerUserId = resolved.ownerUserId;
  if (resolved.kind !== "node") return { ok: true, lead, payerUserId, aiModelId: resolved.aiModelId };
  if (resolved.fallbackAiModelId == null) return { ok: false, reason: ARCH_MESSAGES.nodeNoFallback };
  try {
    const fallback = await resolveModel(resolved.fallbackAiModelId, { userId: payerUserId, mustOwn: true });
    if (fallback.kind === "node") return { ok: false, reason: ARCH_MESSAGES.nodeNoFallback };
    return { ok: true, lead, payerUserId, aiModelId: fallback.aiModelId };
  } catch {
    return { ok: false, reason: ARCH_MESSAGES.nodeNoFallback };
  }
}

// --- righe --------------------------------------------------------------------------------------------------------

async function ensureRow(appId: number): Promise<void> {
  await db.insert(appArchitectureTable).values({ appId }).onConflictDoNothing();
}

async function readRow(appId: number): Promise<AppArchitecture | undefined> {
  const [row] = await db.select().from(appArchitectureTable).where(eq(appArchitectureTable.appId, appId));
  return row;
}

/** Presa in carico: la riga passa a `running` solo se non lo è già. Vero = questa chiamata genera. */
export async function claimGeneration(appId: number): Promise<boolean> {
  await ensureRow(appId);
  const rows = await db
    .update(appArchitectureTable)
    .set({ status: "running", startedAt: sql`now()` })
    .where(and(eq(appArchitectureTable.appId, appId), ne(appArchitectureTable.status, "running")))
    .returning({ appId: appArchitectureTable.appId });
  return rows.length === 1;
}

/** Errore con backoff; con `onlyIfNotRunning` non tocca una generazione in corso (controllo dello SHA). */
async function markError(appId: number, reason: string, opts: { onlyIfNotRunning?: boolean } = {}): Promise<void> {
  const where = opts.onlyIfNotRunning
    ? and(eq(appArchitectureTable.appId, appId), ne(appArchitectureTable.status, "running"))
    : eq(appArchitectureTable.appId, appId);
  const [cur] = await db.select({ errors: appArchitectureTable.consecutiveErrors }).from(appArchitectureTable).where(where);
  if (!cur) return;
  await db
    .update(appArchitectureTable)
    .set({
      status: "error",
      lastError: reason,
      consecutiveErrors: sql`${appArchitectureTable.consecutiveErrors} + 1`,
      nextAttemptAt: new Date(Date.now() + backoffMs(cur.errors)),
    })
    .where(where);
}

// --- generazione --------------------------------------------------------------------------------------------------

/**
 * Genera la sintesi dell'App se la presa in carico riesce. Errori con messaggio fisso, `consecutive_errors + 1` e
 * backoff; tetto di spesa = attesa senza errore. La sintesi precedente resta finché una nuova non riesce.
 */
export async function generateForApp(appId: number): Promise<void> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
  if (!app) return;
  if (!(await claimGeneration(appId))) return;
  let settled = false;
  try {
    const elig = await architectureEligibility(app);
    if (!elig.ok) {
      await markError(appId, elig.reason);
      settled = true;
      logger.info({ appId, outcome: "ineligible" }, "Sintesi dell'architettura non generata");
      return;
    }
    if (!(await userHasInstallation(elig.payerUserId, app.sourceInstallationId!))) {
      await markError(appId, ARCH_MESSAGES.noAccess);
      settled = true;
      logger.info({ appId, outcome: "no_access" }, "Sintesi dell'architettura non generata");
      return;
    }
    const block = await runBudgetBlock({ id: elig.lead.id, aiModelId: elig.aiModelId, monthlyBudgetUsd: elig.lead.monthlyBudgetUsd });
    if (block) {
      // Non è un errore: si riprova al giro dopo
      await db.update(appArchitectureTable).set({ status: "idle", lastError: ARCH_MESSAGES.budgetWait }).where(eq(appArchitectureTable.appId, appId));
      settled = true;
      logger.info({ appId, outcome: "budget" }, "Sintesi dell'architettura in attesa del tetto di spesa");
      return;
    }

    const prev = await readRow(appId);
    let materials;
    try {
      materials = await collectMaterials({ userId: elig.payerUserId, app, previousSha: prev?.sha ?? null, previousSummary: prev?.summary ?? null });
    } catch (err) {
      const reason = err instanceof ArchitectureError ? err.message : ARCH_MESSAGES.internal;
      if (!(err instanceof ArchitectureError)) logger.error({ appId, errName: err instanceof Error ? err.name : "Error" }, "Raccolta dell'architettura non riuscita");
      await markError(appId, reason);
      settled = true;
      return;
    }

    const outcome = await generateSummary({ app, aiModelId: elig.aiModelId, userId: elig.payerUserId, materials, signal: new AbortController().signal });
    const usage = outcome.usage;
    const runRow = {
      appId,
      agentId: elig.lead.id,
      sha: materials.sha,
      aiModelId: elig.aiModelId,
      userId: elig.payerUserId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usageCost(usage),
    };

    if (outcome.ok) {
      await db.transaction(async (tx) => {
        await tx
          .update(appArchitectureTable)
          .set({
            sha: materials.sha,
            seenSha: materials.sha,
            branch: materials.branch,
            repoMap: materials.repoMap,
            summary: outcome.summary,
            generatedAt: sql`now()`,
            aiModelId: elig.aiModelId,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            costUsd: runRow.costUsd,
            status: "idle",
            lastError: null,
            consecutiveErrors: 0,
            nextAttemptAt: null,
            forceRequested: false,
          })
          .where(eq(appArchitectureTable.appId, appId));
        await tx.insert(appArchitectureRunsTable).values({ ...runRow, summary: outcome.summary });
        // Oltre le ultime versioni il testo si svuota: la riga resta, così il costo continua a contare
        const kept = tx
          .select({ id: appArchitectureRunsTable.id })
          .from(appArchitectureRunsTable)
          .where(and(eq(appArchitectureRunsTable.appId, appId), isNotNull(appArchitectureRunsTable.summary)))
          .orderBy(desc(appArchitectureRunsTable.createdAt), desc(appArchitectureRunsTable.id))
          .limit(ARCH_VERSIONS_KEPT);
        await tx
          .update(appArchitectureRunsTable)
          .set({ summary: null })
          .where(
            and(
              eq(appArchitectureRunsTable.appId, appId),
              isNotNull(appArchitectureRunsTable.summary),
              sql`${appArchitectureRunsTable.id} not in (${kept})`,
            ),
          );
      });
      settled = true;
      logger.info(
        { appId, sha7: materials.sha.slice(0, 7), full: materials.full, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, outcome: "ok" },
        "Sintesi dell'architettura generata",
      );
      return;
    }

    await db.transaction(async (tx) => {
      const [cur] = await tx
        .select({ errors: appArchitectureTable.consecutiveErrors })
        .from(appArchitectureTable)
        .where(eq(appArchitectureTable.appId, appId))
        .for("update");
      await tx
        .update(appArchitectureTable)
        .set({
          status: "error",
          lastError: outcome.error,
          consecutiveErrors: sql`${appArchitectureTable.consecutiveErrors} + 1`,
          nextAttemptAt: new Date(Date.now() + backoffMs(cur?.errors ?? 0)),
        })
        .where(eq(appArchitectureTable.appId, appId));
      // Il modello è stato chiamato: la riga serve alla spesa anche senza sintesi
      if (outcome.calledModel) await tx.insert(appArchitectureRunsTable).values({ ...runRow, summary: null });
    });
    settled = true;
    logger.info(
      { appId, sha7: materials.sha.slice(0, 7), promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, outcome: "failed" },
      "Sintesi dell'architettura non riuscita",
    );
  } catch (err) {
    logger.error({ appId, errName: err instanceof Error ? err.name : "Error" }, "Generazione dell'architettura non riuscita");
  } finally {
    // Mai una riga lasciata `running` da un errore inatteso
    if (!settled) await markError(appId, ARCH_MESSAGES.internal).catch(() => {});
  }
}

// --- controllo dello SHA --------------------------------------------------------------------------------------------

function shaReadError(err: unknown): string {
  if (err instanceof SourceError) {
    if (err.status === 404) return CODE_MESSAGES.notFound;
    if (err.status === 401 || err.status === 403) return ARCH_MESSAGES.noAccess;
    return ARCH_MESSAGES.githubDown;
  }
  if (err instanceof GithubError) return err.status == null || err.status >= 500 ? ARCH_MESSAGES.githubDown : ARCH_MESSAGES.noAccess;
  return ARCH_MESSAGES.internal;
}

/**
 * Legge lo SHA del branch base (token `contents: read`, nessun token utente), aggiorna `checked_at` e `seen_sha`
 * e, se è il momento, genera. In backoff aggiorna solo `checked_at` (niente rete), così l'App scorre nella coda.
 */
export async function checkApp(app: App): Promise<void> {
  await ensureRow(app.id);
  const row = await readRow(app.id);
  if (!row) return;
  const touch = () => db.update(appArchitectureTable).set({ checkedAt: sql`now()` }).where(eq(appArchitectureTable.appId, app.id));
  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()) {
    await touch();
    return;
  }
  const cfg = codeReaderGithubConfig();
  if (!cfg || !hasGithubInstallation(app)) {
    await touch();
    return;
  }
  let sha: string;
  try {
    const token = await installationToken(cfg, app.sourceInstallationId!, { repo: app.sourceRepo!, permissions: { contents: "read" } });
    sha = await fetchBranchSha({ apiBase: cfg.apiBase, repo: app.sourceRepo!, branch: app.sourceBranch, token });
  } catch (err) {
    const reason = shaReadError(err);
    await touch();
    await markError(app.id, reason, { onlyIfNotRunning: true });
    logger.info({ appId: app.id, outcome: "sha_error" }, "Controllo dello SHA dell'architettura non riuscito");
    return;
  }
  const [updated] = await db
    .update(appArchitectureTable)
    .set({ checkedAt: sql`now()`, seenSha: sha })
    .where(eq(appArchitectureTable.appId, app.id))
    .returning();
  if (updated && updated.status !== "running" && isDue(updated, app.architectureRefresh, new Date())) {
    logger.info({ appId: app.id, sha7: sha.slice(0, 7) }, "Sintesi dell'architettura da rigenerare");
    await generateForApp(app.id);
  }
}

// --- richieste e avvio ------------------------------------------------------------------------------------------------

const background = new Set<Promise<void>>();

function inBackground(p: Promise<void>): void {
  const tracked = p
    .catch((err: unknown) => logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Controllo dell'architettura non riuscito"))
    .finally(() => background.delete(tracked));
  background.add(tracked);
}

/**
 * «Aggiorna ora» e merge riusciti: imposta `force_requested` (e toglie un backoff in corso: è una richiesta
 * esplicita) e avvia `checkApp` senza attendere. Con frequenza `off` e senza `bypassOff` non fa nulla.
 * Risponde `queued`, `running`, `off` o un messaggio fisso (app inesistente o non idonea).
 */
export async function requestArchitectureRefresh(appId: number, opts: { bypassOff: boolean }): Promise<"queued" | "running" | "off" | string> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
  if (!app) return ARCH_MESSAGES.appNotFound;
  if (app.architectureRefresh === "off" && !opts.bypassOff) return "off";
  const elig = await architectureEligibility(app);
  if (!elig.ok) return elig.reason;
  await ensureRow(appId);
  const rows = await db
    .update(appArchitectureTable)
    .set({ forceRequested: true, nextAttemptAt: null })
    .where(and(eq(appArchitectureTable.appId, appId), ne(appArchitectureTable.status, "running")))
    .returning({ appId: appArchitectureTable.appId });
  if (rows.length === 0) return "running";
  inBackground(checkApp(app));
  return "queued";
}

/** All'avvio: le generazioni rimaste `running` diventano `error` («generazione interrotta dal riavvio»). */
export async function failInterruptedArchitecture(): Promise<void> {
  const rows = await db
    .update(appArchitectureTable)
    .set({ status: "error", lastError: ARCH_MESSAGES.interrupted })
    .where(eq(appArchitectureTable.status, "running"))
    .returning({ appId: appArchitectureTable.appId });
  if (rows.length > 0) logger.warn({ count: rows.length }, "Sintesi dell'architettura interrotte dal riavvio");
}

/** Solo per i test: attende i controlli avviati in background. */
export async function waitArchitectureIdleForTests(): Promise<void> {
  while (background.size > 0) await Promise.all([...background]);
}
