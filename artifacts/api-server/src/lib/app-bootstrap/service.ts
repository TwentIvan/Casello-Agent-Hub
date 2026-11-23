import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  agentsTable,
  aiModelsTable,
  analysesTable,
  appBootstrapsTable,
  appsTable,
  pendingActionsTable,
  type App,
  type AppBootstrap,
  type BootstrapStep,
  type PendingActionRow,
} from "@workspace/db";
import { logger } from "../logger";
import { isUniqueViolation } from "../pg-errors";
import { looksLikeCredential } from "../memory/credentials";
import { MODEL_UNAVAILABLE, ModelChoiceError, chooseCloudModel, type ModelChoice } from "../ai/choice";
import { estimateAnalysisCost } from "../ai/estimate";
import { userBudgetBlock } from "../budget";
import { luciusBestPracticeDefault } from "../characters/settings";
import { AnalysisBusyError, createAndStartAnalysis } from "../architect/start";
import { INSTALLATION_NOT_YOURS, REPO_NOT_VISIBLE, REPOS_NOT_VERIFIED, userRepoAccess } from "../github/installations";
import { enqueueAppBootstrapItem } from "../actions/queue";
import type { DecideResult } from "../actions/decide";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";

/** Stesso testo di `ACTION_MESSAGES.alreadyDecided` (niente import da `decide.ts`, che importa questo modulo). */
const ACTION_ALREADY_DECIDED = "azione già decisa";
const INTERNAL = "errore interno: usa Riprova";
import { bootstrapNames, normalizeDomain, validateSlug } from "./naming";
import { personalizeFiles } from "./personalize";
import { initializeRepo, inspectRepo, type RepoInspection } from "./github";

/**
 * Nascita di un'App da zero: richiesta con la voce `app_bootstrap` in «Da confermare», decisione ed esecuzione a passi
 * ripetibili (verifica del repository, commit di inizializzazione su `main`, App con il Responsabile, analisi). Ogni passo
 * è registrato in `app_bootstraps.steps`; «Riprova» riparte dal primo passo non fatto. Log: solo id, slug, sha a 7
 * caratteri ed esiti, mai brief né contenuti.
 */

const STEP_KEYS = ["verify", "personalize", "register", "analyze"] as const;
type StepKey = (typeof STEP_KEYS)[number];

const BRIEF_MAX = 20_000;
const NAME_MAX = 80;
const MONTHLY_TEXT = "in tappa 1 nulla: Neon e Coolify li crei tu (lista guidata)";

export type CreateBootstrapInput = {
  name: string;
  slug: string;
  domain: string;
  brief: string;
  repo: string;
  installationId: number;
  aiModelId: number;
};

export type CreateBootstrapResult =
  | { ok: true; id: number; pendingActionNumber: number }
  | { ok: false; status: 400 | 403 | 409; message: string };

export type RetryBootstrapResult = { ok: true; row: AppBootstrap } | { ok: false; status: 404 | 409; message: string };

const bad = (status: 400 | 403 | 409, message: string): CreateBootstrapResult => ({ ok: false, status, message });

function initialSteps(): BootstrapStep[] {
  return STEP_KEYS.map((key) => ({ key, status: "pending", message: null, at: null }));
}

/** Host di un `base_url` salvato, in minuscolo; null se non si legge. */
function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Errore interno alla transazione della richiesta: la annulla e porta il messaggio della coda. */
class QueueFullError extends Error {}

export async function createBootstrap(userId: number, body: CreateBootstrapInput): Promise<CreateBootstrapResult> {
  const name = body.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) return bad(400, M.nameInvalid);
  const slug = body.slug.trim();
  const slugError = validateSlug(slug);
  if (slugError) return bad(400, slugError);
  const dom = normalizeDomain(body.domain);
  if (!dom.ok) return bad(400, dom.message);
  const domain = dom.domain;
  const brief = body.brief;
  if (brief.trim().length < 1 || brief.length > BRIEF_MAX) return bad(400, M.briefInvalid);
  if (looksLikeCredential(brief)) return bad(400, M.briefCredential);
  const parts = body.repo.trim().split("/");
  if (parts.length !== 2 || !parts[0] || parts[1]!.toLowerCase() !== slug) return bad(400, M.repoMismatch);
  const repo = body.repo.trim().toLowerCase();

  const access = await userRepoAccess(userId, body.installationId, repo);
  if (access !== "ok") {
    return bad(403, access === "no_installation" ? INSTALLATION_NOT_YOURS : access === "not_verified" ? REPOS_NOT_VERIFIED : REPO_NOT_VISIBLE);
  }

  let choice: ModelChoice;
  try {
    choice = await chooseCloudModel(body.aiModelId, userId);
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    return bad(400, err.message);
  }

  const [taken] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.slug, slug)).limit(1);
  if (taken) return bad(409, M.slugTaken(slug));
  const apps = await db.select({ baseUrl: appsTable.baseUrl }).from(appsTable);
  if (apps.some((a) => hostOf(a.baseUrl) === domain)) return bad(409, M.domainTaken);

  const [model] = await db
    .select({ priceInputPerMtok: aiModelsTable.priceInputPerMtok, priceOutputPerMtok: aiModelsTable.priceOutputPerMtok, displayName: aiModelsTable.displayName })
    .from(aiModelsTable)
    .where(eq(aiModelsTable.id, choice.aiModelId!))
    .limit(1);
  const analysisEstimateUsd = model ? estimateAnalysisCost(model).maxUsd : null;
  const modelName = model?.displayName ?? choice.model;
  const owner = parts[0]!;
  const names = bootstrapNames(slug, owner);

  try {
    const out = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(appBootstrapsTable)
        .values({ userId, slug, name, domain, repo, installationId: body.installationId, brief, aiModelId: choice.aiModelId, steps: initialSteps() })
        .returning({ id: appBootstrapsTable.id });
      const id = row!.id;
      const queued = await enqueueAppBootstrapItem(
        {
          userId,
          recipient: repo,
          summary: `Crea l'app ${name} da zero`,
          detail: {
            bootstrapId: id,
            name,
            slug,
            domain,
            repo,
            names,
            steps: [
              `Verifica del repository ${repo}: installazione, modello, main intatto`,
              `Commit «Inizializza ${name}» su main di ${repo}, con i file cambiati e quelli rinominati`,
              `App ${slug} con indirizzo https://${domain}, sorgente GitHub su main, descrizione funzionale = brief, Responsabile con ${modelName}`,
              `Analisi dell'architetto con ${modelName}`,
            ],
            analysisEstimateUsd,
            monthly: MONTHLY_TEXT,
          },
        },
        tx,
      );
      if (!queued.ok) throw new QueueFullError(queued.message);
      const [action] = await tx
        .select({ id: pendingActionsTable.id })
        .from(pendingActionsTable)
        .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, queued.number)))
        .limit(1);
      await tx.update(appBootstrapsTable).set({ pendingActionId: action!.id }).where(eq(appBootstrapsTable.id, id));
      return { id, number: queued.number };
    });
    logger.info({ bootstrapId: out.id, slug }, "Nuova app da zero: richiesta in coda");
    return { ok: true, id: out.id, pendingActionNumber: out.number };
  } catch (err) {
    if (err instanceof QueueFullError) return bad(409, err.message);
    if (isUniqueViolation(err, "app_bootstraps_slug_open_uidx") || isUniqueViolation(err, "app_bootstraps_repo_open_uidx")) {
      return bad(409, M.requestOpen);
    }
    throw err;
  }
}

/** Richiesta della voce assente o non più in attesa: annulla la transazione dell'approvazione. */
class NotPendingError extends Error {}

/** Esecuzioni in corso in questo processo, per id della richiesta (i test le attendono con `settleBootstrapRuns`). */
const inFlight = new Map<number, Promise<void>>();

function launch(id: number, actionId: number): Promise<void> {
  const p = runBootstrap(id, actionId).finally(() => {
    if (inFlight.get(id) === p) inFlight.delete(id);
  });
  inFlight.set(id, p);
  return p;
}

/** Attende le esecuzioni partite in questo processo (solo test). */
export async function settleBootstrapRuns(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
}

/** Approvazione: voce `pending` → `executing`, richiesta → `running`, poi i passi in background (`void`). */
export async function approveBootstrap(userId: number, action: PendingActionRow): Promise<DecideResult> {
  let claimed: { action: PendingActionRow; id: number } | null;
  try {
    claimed = await db.transaction(async (tx) => {
      const [executing] = await tx
        .update(pendingActionsTable)
        .set({ status: "executing", decidedBy: userId, decidedAt: new Date() })
        .where(and(eq(pendingActionsTable.id, action.id), eq(pendingActionsTable.status, "pending")))
        .returning();
      if (!executing) return null;
      const [row] = await tx
        .update(appBootstrapsTable)
        .set({ status: "running", updatedAt: new Date() })
        .where(and(eq(appBootstrapsTable.pendingActionId, action.id), eq(appBootstrapsTable.status, "pending")))
        .returning({ id: appBootstrapsTable.id });
      if (!row) throw new NotPendingError();
      return { action: executing, id: row.id };
    });
  } catch (err) {
    if (err instanceof NotPendingError) return { ok: false, status: 409, message: M.notRetryable };
    throw err;
  }
  if (!claimed) return { ok: false, status: 409, message: ACTION_ALREADY_DECIDED };
  void launch(claimed.id, action.id);
  return { ok: true, action: claimed.action };
}

/** Rifiuto della voce (nella transazione del rifiuto): la richiesta si chiude e libera slug e repository. */
export async function rejectBootstrap(action: PendingActionRow, _note: string | null, tx: Pick<typeof db, "update"> = db): Promise<void> {
  await tx
    .update(appBootstrapsTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(and(eq(appBootstrapsTable.pendingActionId, action.id), eq(appBootstrapsTable.status, "pending")));
}

/** Errore di un passo con il messaggio fisso. */
class StepError extends Error {}

/**
 * La richiesta non è più `running` (chiusa da un altro processo, es. dal riavvio durante un deploy, o ripresa con
 * Riprova): questo esecutore smette di scrivere, senza segnarla fallita.
 */
class StaleRunError extends Error {}

async function saveSteps(id: number, steps: BootstrapStep[], extra: Partial<typeof appBootstrapsTable.$inferInsert> = {}): Promise<void> {
  const saved = await db
    .update(appBootstrapsTable)
    .set({ ...extra, steps: steps.map((s) => ({ ...s })), updatedAt: new Date() })
    .where(and(eq(appBootstrapsTable.id, id), eq(appBootstrapsTable.status, "running")))
    .returning({ id: appBootstrapsTable.id });
  if (saved.length === 0) throw new StaleRunError();
}

async function loadRow(id: number): Promise<AppBootstrap | undefined> {
  const [row] = await db.select().from(appBootstrapsTable).where(eq(appBootstrapsTable.id, id)).limit(1);
  return row;
}

async function inspect(row: AppBootstrap): Promise<Exclude<RepoInspection, { kind: "error" }>> {
  const r = await inspectRepo({ repo: row.repo, installationId: row.installationId, slug: row.slug });
  if (r.kind === "error") throw new StepError(r.message);
  return r;
}

async function modelFor(row: AppBootstrap): Promise<ModelChoice> {
  if (row.aiModelId === null) throw new StepError(MODEL_UNAVAILABLE);
  try {
    return await chooseCloudModel(row.aiModelId, row.userId);
  } catch (err) {
    if (err instanceof ModelChoiceError) throw new StepError(err.message);
    throw err;
  }
}

/** Passo `register`: App con lo slug esatto e il Responsabile, legati alla richiesta nella stessa transazione. */
async function registerApp(row: AppBootstrap): Promise<number> {
  const choice = await modelFor(row);
  try {
    return await db.transaction(async (tx) => {
      const [app] = await tx
        .insert(appsTable)
        .values({
          name: row.name,
          slug: row.slug,
          baseUrl: `https://${row.domain}`,
          sourceType: "github",
          sourceRepo: row.repo,
          sourceInstallationId: row.installationId,
          sourceBranch: "main",
          functionalDescription: row.brief,
        })
        .returning({ id: appsTable.id, name: appsTable.name });
      await tx.insert(agentsTable).values({
        appId: app!.id,
        name: `${app!.name} – generale`,
        role: "general",
        status: "draft",
        ...choice,
      });
      const linked = await tx
        .update(appBootstrapsTable)
        .set({ appId: app!.id, updatedAt: new Date() })
        .where(and(eq(appBootstrapsTable.id, row.id), eq(appBootstrapsTable.status, "running")))
        .returning({ id: appBootstrapsTable.id });
      // Richiesta non più nostra: la transazione si annulla e l'App non nasce
      if (linked.length === 0) throw new StaleRunError();
      return app!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err, "apps_slug_unique")) throw new StepError(M.slugTaken(row.slug));
    throw err;
  }
}

/** Passo `analyze`: analisi cloud completa con il modello scelto; un'analisi già aperta per l'App vale come avviata. */
async function startAppAnalysis(row: AppBootstrap): Promise<number> {
  const choice = await modelFor(row);
  const blocked = await userBudgetBlock(choice.aiModelId);
  if (blocked) throw new StepError(M.budget(blocked));
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, row.appId!)).limit(1);
  if (!app) throw new StepError(M.notFound);
  try {
    const analysis = await createAndStartAnalysis(app as App, choice, undefined, await luciusBestPracticeDefault(row.userId));
    return analysis.id;
  } catch (err) {
    if (!(err instanceof AnalysisBusyError)) throw err;
    const [open] = await db
      .select({ id: analysesTable.id })
      .from(analysesTable)
      .where(and(eq(analysesTable.appId, app.id), inArray(analysesTable.status, ["queued", "running"])))
      .limit(1);
    if (!open) throw new StepError(INTERNAL);
    return open.id;
  }
}

/**
 * Esegue in ordine i passi non ancora fatti di una richiesta `running` e salva ciascuno. Non lancia mai: al primo errore
 * il passo, la richiesta e la voce diventano `failed` con il messaggio fisso.
 */
export async function runBootstrap(id: number, actionId: number): Promise<void> {
  let current: StepKey | null = null;
  let steps: BootstrapStep[] = [];
  try {
    const loaded = await loadRow(id);
    if (!loaded || loaded.status !== "running") return;
    let row: AppBootstrap = loaded;
    steps = STEP_KEYS.map((key) => row.steps.find((s) => s.key === key) ?? { key, status: "pending", message: null, at: null });
    let inspection: Exclude<RepoInspection, { kind: "error" }> | null = null;

    for (const step of steps) {
      if (step.status === "done") continue;
      current = step.key;
      const extra: Partial<typeof appBootstrapsTable.$inferInsert> = {};
      switch (step.key) {
        case "verify":
          inspection = await inspect(row);
          break;
        case "personalize": {
          const r = inspection ?? (await inspect(row));
          inspection = null;
          if (r.kind === "initialized") {
            extra.initCommitSha = r.headSha;
            break;
          }
          const personalized = personalizeFiles(r.files, { slug: row.slug, name: row.name, domain: row.domain, brief: row.brief }, r.entries);
          if ("error" in personalized) throw new StepError(personalized.error);
          const commit = await initializeRepo({
            repo: row.repo,
            installationId: row.installationId,
            parentSha: r.headSha,
            baseTreeSha: r.treeSha,
            changes: personalized.changes,
            modes: personalized.modes,
            reuse: personalized.reuse,
            message: `Inizializza ${row.name}\n\nBotcave · nuova app da zero · richiesta ${row.id}`,
          });
          if ("error" in commit) throw new StepError(commit.error);
          extra.initCommitSha = commit.sha;
          logger.info({ bootstrapId: id, slug: row.slug, sha: commit.sha.slice(0, 7) }, "Nuova app da zero: commit di inizializzazione");
          break;
        }
        case "register":
          if (row.appId === null) await registerApp(row);
          break;
        case "analyze":
          if (row.analysisId === null) extra.analysisId = await startAppAnalysis(row);
          break;
      }
      step.status = "done";
      step.message = null;
      step.at = new Date().toISOString();
      await saveSteps(id, steps, extra);
      row = (await loadRow(id)) ?? row;
    }

    await db
      .update(appBootstrapsTable)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(appBootstrapsTable.id, id), eq(appBootstrapsTable.status, "running")));
    await db
      .update(pendingActionsTable)
      .set({ status: "done", result: `App ${row.name} pronta: completa la lista guidata`, errorMessage: null, finishedAt: new Date() })
      .where(and(eq(pendingActionsTable.id, actionId), eq(pendingActionsTable.status, "executing")));
    logger.info({ bootstrapId: id, slug: row.slug }, "Nuova app da zero: passi completati");
  } catch (err) {
    if (err instanceof StaleRunError) {
      logger.warn({ bootstrapId: id, step: current }, "Nuova app da zero: richiesta non più in esecuzione qui, passi interrotti");
      return;
    }
    const message = err instanceof StepError ? err.message : INTERNAL;
    if (!(err instanceof StepError)) {
      logger.error({ bootstrapId: id, step: current, errName: err instanceof Error ? err.name : "unknown" }, "Nuova app da zero: errore interno");
    } else {
      logger.warn({ bootstrapId: id, step: current }, "Nuova app da zero: passo non riuscito");
    }
    await markFailed(id, actionId, steps, current, message).catch((e: unknown) =>
      logger.error({ bootstrapId: id, errName: e instanceof Error ? e.name : "unknown" }, "Nuova app da zero: esito non registrato"),
    );
  }
}

async function markFailed(id: number, actionId: number, steps: BootstrapStep[], key: StepKey | null, message: string): Promise<void> {
  const failedKey = key ?? "verify";
  const next = steps.length > 0 ? steps : initialSteps();
  const step = next.find((s) => s.key === failedKey);
  if (step) {
    step.status = "failed";
    step.message = message;
    step.at = new Date().toISOString();
  }
  await db
    .update(appBootstrapsTable)
    .set({ status: "failed", steps: next, updatedAt: new Date() })
    .where(and(eq(appBootstrapsTable.id, id), eq(appBootstrapsTable.status, "running")));
  await db
    .update(pendingActionsTable)
    .set({ status: "failed", errorMessage: `passo ${failedKey}: ${message}`, finishedAt: new Date() })
    .where(and(eq(pendingActionsTable.id, actionId), eq(pendingActionsTable.status, "executing")));
}

/**
 * «Riprova»: solo il proprietario e solo da `failed`. Richiesta → `running`, voce `failed` → `executing`, i passi
 * falliti tornano `pending`; poi i passi in background dal primo non fatto.
 */
export async function retryBootstrap(userId: number, id: number): Promise<RetryBootstrapResult> {
  const row = await loadRow(id);
  if (!row || row.userId !== userId) return { ok: false, status: 404, message: M.notFound };
  if (row.status !== "failed") return { ok: false, status: 409, message: M.notRetryable };
  const steps = row.steps.map((s) => (s.status === "failed" ? { ...s, status: "pending" as const, message: null } : s));
  let updated: AppBootstrap | undefined;
  try {
    updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(appBootstrapsTable)
        .set({ status: "running", steps, updatedAt: new Date() })
        .where(and(eq(appBootstrapsTable.id, id), eq(appBootstrapsTable.status, "failed")))
        .returning();
      if (!u) return undefined;
      if (u.pendingActionId !== null) {
        await tx
          .update(pendingActionsTable)
          .set({ status: "executing", errorMessage: null, result: null, finishedAt: null })
          .where(and(eq(pendingActionsTable.id, u.pendingActionId), eq(pendingActionsTable.status, "failed")));
      }
      return u;
    });
  } catch (err) {
    // Nel frattempo è nata un'altra richiesta aperta per lo stesso slug o repository
    if (isUniqueViolation(err, "app_bootstraps_slug_open_uidx") || isUniqueViolation(err, "app_bootstraps_repo_open_uidx")) {
      return { ok: false, status: 409, message: M.requestOpen };
    }
    throw err;
  }
  if (!updated) return { ok: false, status: 409, message: M.notRetryable };
  void launch(id, updated.pendingActionId ?? -1);
  return { ok: true, row: updated };
}

/** All'avvio: le richieste rimaste `running` falliscono «interrotto dal riavvio» sul passo in corso, con la loro voce. */
export async function failInterruptedBootstraps(): Promise<number> {
  const rows = await db.select().from(appBootstrapsTable).where(eq(appBootstrapsTable.status, "running"));
  for (const row of rows) {
    const steps = row.steps.map((s) => ({ ...s }));
    const step = steps.find((s) => s.status !== "done");
    const key = step?.key ?? "analyze";
    if (step) {
      step.status = "failed";
      step.message = M.interrupted;
      step.at = new Date().toISOString();
    }
    await db
      .update(appBootstrapsTable)
      .set({ status: "failed", steps, updatedAt: new Date() })
      .where(and(eq(appBootstrapsTable.id, row.id), eq(appBootstrapsTable.status, "running")));
    if (row.pendingActionId !== null) {
      await db
        .update(pendingActionsTable)
        .set({ status: "failed", errorMessage: `passo ${key}: ${M.interrupted}`, finishedAt: new Date() })
        .where(and(eq(pendingActionsTable.id, row.pendingActionId), eq(pendingActionsTable.status, "executing")));
    }
  }
  return rows.length;
}
