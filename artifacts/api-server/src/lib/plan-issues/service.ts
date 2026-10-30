import { and, asc, eq, inArray, count, isNotNull, isNull, min } from "drizzle-orm";
import { db, analysesTable, analysisItemsTable, appsTable, type AnalysisItem } from "@workspace/db";
import { githubConfig } from "../github/config";
import { IssueError, createIssue, ensureLabels, issuesToken, listCaselloIssues } from "../github/issues";
import { completionData } from "../architect/issues";
import { INSTALLATION_NOT_YOURS, userHasInstallation } from "../../routes/apps";
import { latestCompletedAnalysisId, loadPlanItems } from "../plan-chat/run-turn";
import { creationOrder, isEligible, issueContent, issueLabels } from "./content";
import { logger } from "../logger";

/**
 * Creazione delle issue GitHub dalle voci approvate del piano (spec «dal piano alle issue», §4).
 * Ogni voce si prenota (`issue_state = 'creating'`) prima della chiamata a GitHub: due richieste
 * concorrenti sulle stesse voci non creano doppioni. Se la creazione su GitHub fallisce la prenotazione
 * si toglie; se fallisce solo il collegamento alla voce resta (l'issue esiste: si ricollega a mano dal
 * log). Quelle rimaste da un riavvio si azzerano all'avvio (`resetStaleIssueReservations`).
 */

export class PlanIssuesError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 502;
  constructor(status: 400 | 403 | 404 | 409 | 502, message: string) {
    super(message);
    this.name = "PlanIssuesError";
    this.status = status;
  }
}

export const NO_REPO = "Collega il repository tramite l'App GitHub per creare le issue";
const APP_NOT_FOUND = "App non trovata";
const ITEM_NOT_IN_APP = "Una o più voci non appartengono al piano di questa app";

/** Pausa tra due tentativi di creazione: GitHub limita la creazione rapida di contenuti. */
const DEFAULT_PAUSE_MS = 1000;

export interface PlanIssuePreview {
  itemId: number;
  title: string;
  body: string;
  labels: string[];
  skipped: boolean;
}

/** Riepilogo delle issue sulle voci del piano (`AppPlan.issues`). */
export interface PlanIssuesSummary {
  available: boolean;
  unavailableReason: string | null;
  repo: string | null;
  open: number;
  closed: number;
  approvedWithoutIssue: number;
  checkedAt: Date | null;
}

export interface PlanIssueResult {
  itemId: number;
  outcome: "created" | "skipped" | "failed";
  number?: number;
  url?: string;
  error?: string;
}

/** Repository e installazione su cui creare le issue dell'app, per quell'utente. */
export async function issueTarget(
  appId: number,
  userId: number,
): Promise<{ repo: string; installationId: number; appName: string }> {
  const [app] = await db
    .select({ name: appsTable.name, sourceRepo: appsTable.sourceRepo, sourceInstallationId: appsTable.sourceInstallationId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!app) throw new PlanIssuesError(404, APP_NOT_FOUND);
  if (!app.sourceRepo || app.sourceInstallationId === null || !githubConfig()) throw new PlanIssuesError(409, NO_REPO);
  if (!(await userHasInstallation(userId, app.sourceInstallationId))) throw new PlanIssuesError(403, INSTALLATION_NOT_YOURS);
  return { repo: app.sourceRepo, installationId: app.sourceInstallationId, appName: app.name };
}

/** Le voci richieste, nell'ordine ricevuto; 400 se una non è di un'analisi dell'app. */
async function loadRequestedItems(appId: number, itemIds: number[]): Promise<AnalysisItem[]> {
  const rows = await db
    .select({ item: analysisItemsTable })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(and(eq(analysesTable.appId, appId), inArray(analysisItemsTable.id, itemIds)));
  const byId = new Map(rows.map((r) => [r.item.id, r.item]));
  const items = itemIds.map((id) => byId.get(id));
  if (items.some((i) => i === undefined)) throw new PlanIssuesError(400, ITEM_NOT_IN_APP);
  return items as AnalysisItem[];
}

/**
 * Chiavi del completamento dell'app: numero dell'issue già collegata sullo stesso repo e titolo
 * (per le dipendenze ancora senza issue). A parità di chiave prevale la voce più recente.
 */
async function completionKeys(appId: number, repo: string): Promise<{ issueByKey: Map<string, number>; titleByKey: Map<string, string> }> {
  const rows = await db
    .select({ item: analysisItemsTable })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(and(eq(analysesTable.appId, appId), eq(analysisItemsTable.chapter, "completion")))
    .orderBy(asc(analysisItemsTable.id));
  const issueByKey = new Map<string, number>();
  const titleByKey = new Map<string, string>();
  for (const { item } of rows) {
    const { key, title } = completionData(item);
    titleByKey.set(key, title);
    if (item.issueNumber !== null && item.issueRepo === repo) issueByKey.set(key, item.issueNumber);
  }
  return { issueByKey, titleByKey };
}

/** Da creare: ammessa e non ancora collegata né prenotata. */
function isCandidate(item: AnalysisItem): boolean {
  return isEligible(item) && item.issueNumber === null && item.issueState === null;
}

export async function previewPlanIssues(
  appId: number,
  userId: number,
  itemIds: number[],
): Promise<{ repo: string; issues: PlanIssuePreview[] }> {
  const { repo, appName } = await issueTarget(appId, userId);
  const items = creationOrder(await loadRequestedItems(appId, itemIds));
  const { issueByKey, titleByKey } = await completionKeys(appId, repo);
  return {
    repo,
    issues: items.map((item) => ({
      itemId: item.id,
      ...issueContent(item, { appName, issueByKey, titleByKey }),
      skipped: !isCandidate(item),
    })),
  };
}

/** Prenota la voce: nessuna riga se è già collegata o prenotata da un'altra richiesta. */
async function reserve(itemId: number): Promise<boolean> {
  const rows = await db
    .update(analysisItemsTable)
    .set({ issueState: "creating" })
    .where(and(eq(analysisItemsTable.id, itemId), isNull(analysisItemsTable.issueNumber), isNull(analysisItemsTable.issueState)))
    .returning({ id: analysisItemsTable.id });
  return rows.length > 0;
}

async function release(itemId: number): Promise<void> {
  await db
    .update(analysisItemsTable)
    .set({ issueState: null })
    .where(and(eq(analysisItemsTable.id, itemId), isNull(analysisItemsTable.issueNumber), eq(analysisItemsTable.issueState, "creating")));
}

/** Toglie la prenotazione senza coprire l'errore originale: se fallisce, la azzera il prossimo avvio. */
async function releaseQuietly(itemId: number): Promise<void> {
  try {
    await release(itemId);
  } catch (e) {
    logger.error({ itemId, err: e }, "prenotazione dell'issue non tolta");
  }
}

const notLinkedMessage = (n: number) => `Issue creata su GitHub ma non collegata alla voce: ricollegala a mano (#${n})`;

/** Collega l'issue creata alla voce; un secondo tentativo se la scrittura fallisce. */
async function linkIssue(itemId: number, repo: string, issue: { number: number; url: string }): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const now = new Date();
      await db
        .update(analysisItemsTable)
        .set({
          issueRepo: repo,
          issueNumber: issue.number,
          issueUrl: issue.url,
          issueState: "open",
          issueStateReason: null,
          issueCreatedAt: now,
          issueCheckedAt: now,
        })
        .where(eq(analysisItemsTable.id, itemId));
      return true;
    } catch {
      // riprova una volta
    }
  }
  return false;
}

export async function createPlanIssues(
  appId: number,
  userId: number,
  itemIds: number[],
  opts: { pauseMs?: number } = {},
): Promise<{ repo: string; results: PlanIssueResult[] }> {
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  const { repo, installationId, appName } = await issueTarget(appId, userId);
  const items = creationOrder(await loadRequestedItems(appId, itemIds));
  const candidates = items.filter(isCandidate);
  if (!candidates.length) return { repo, results: items.map((i) => ({ itemId: i.id, outcome: "skipped" })) };

  // issueTarget garantisce la configurazione
  const cfg = githubConfig()!;
  let token: string;
  try {
    token = await issuesToken(cfg, installationId, repo);
    await ensureLabels(cfg, token, repo, candidates.flatMap(issueLabels));
  } catch (e) {
    if (e instanceof IssueError) throw new PlanIssuesError(502, e.message);
    throw e;
  }

  const { issueByKey, titleByKey } = await completionKeys(appId, repo);
  const results: PlanIssueResult[] = [];
  let stopped: string | null = null;
  let attempts = 0;
  for (const item of items) {
    if (stopped !== null) {
      results.push({ itemId: item.id, outcome: "failed", error: stopped });
      continue;
    }
    if (!isCandidate(item) || !(await reserve(item.id))) {
      results.push({ itemId: item.id, outcome: "skipped" });
      continue;
    }
    if (attempts > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    attempts++;
    const content = issueContent(item, { appName, issueByKey, titleByKey });
    let issue: { number: number; url: string };
    try {
      issue = await createIssue(cfg, token, repo, content);
    } catch (e) {
      // Solo una creazione fallita libera la voce: l'issue non esiste su GitHub
      await releaseQuietly(item.id);
      if (!(e instanceof IssueError)) throw e;
      // Un errore di repository o permesso ferma il lotto: questa voce e le restanti falliscono
      if (e.scope === "batch") stopped = e.message;
      results.push({ itemId: item.id, outcome: "failed", error: e.message });
      continue;
    }
    if (!(await linkIssue(item.id, repo, issue))) {
      // L'issue esiste ma la voce non lo sa: la prenotazione resta, così nessun lotto crea un doppione
      logger.error({ itemId: item.id, repo, number: issue.number, url: issue.url }, "issue creata ma non collegata alla voce del piano");
      results.push({ itemId: item.id, outcome: "failed", error: notLinkedMessage(issue.number) });
      continue;
    }
    if (item.chapter === "completion") issueByKey.set(completionData(item).key, issue.number);
    results.push({ itemId: item.id, outcome: "created", number: issue.number, url: issue.url });
  }
  return { repo, results };
}

/** All'avvio: le prenotazioni rimaste (`creating` senza numero) tornano libere. */
export async function resetStaleIssueReservations(): Promise<number> {
  const rows = await db
    .update(analysisItemsTable)
    .set({ issueState: null })
    .where(and(eq(analysisItemsTable.issueState, "creating"), isNull(analysisItemsTable.issueNumber)))
    .returning({ id: analysisItemsTable.id });
  return rows.length;
}

/**
 * Riepilogo sulle voci del piano (quelle di `GET /apps/:id/plan`; si possono passare se già lette).
 * Non lancia se manca il repo o l'installazione non è dell'utente: `available` false col motivo.
 */
export async function planIssuesSummary(appId: number, userId: number, planItems?: AnalysisItem[]): Promise<PlanIssuesSummary> {
  let target: { repo: string } | null = null;
  let unavailableReason: string | null = null;
  try {
    target = await issueTarget(appId, userId);
  } catch (e) {
    if (!(e instanceof PlanIssuesError) || e.status === 404) throw e;
    unavailableReason = e.message;
  }
  let items = planItems;
  if (items === undefined) {
    const analysisId = await latestCompletedAnalysisId(appId);
    items = analysisId === null ? [] : await loadPlanItems(analysisId, appId);
  }
  let open = 0;
  let closed = 0;
  let approvedWithoutIssue = 0;
  let checkedAt: Date | null = null;
  for (const item of items) {
    if (item.issueNumber === null) {
      if (isEligible(item)) approvedWithoutIssue++;
      continue;
    }
    if (item.issueState === "open") open++;
    else if (item.issueState === "closed") closed++;
    if (item.issueCheckedAt && (checkedAt === null || item.issueCheckedAt < checkedAt)) checkedAt = item.issueCheckedAt;
  }
  return {
    available: target !== null,
    unavailableReason,
    repo: target?.repo ?? null,
    open,
    closed,
    approvedWithoutIssue,
    checkedAt,
  };
}

/** Condizione delle voci dell'app collegate a un'issue del repo. */
function linkedTo(appId: number, repo: string) {
  return and(
    inArray(
      analysisItemsTable.analysisId,
      db.select({ id: analysesTable.id }).from(analysesTable).where(eq(analysesTable.appId, appId)),
    ),
    eq(analysisItemsTable.issueRepo, repo),
    isNotNull(analysisItemsTable.issueNumber),
  );
}

/**
 * Rilegge da GitHub lo stato delle issue collegate alle voci dell'app (solo quelle aggiornate dalla
 * lettura più vecchia). Un'issue non più nell'elenco (es. etichetta tolta) resta com'era; la data di
 * lettura avanza per tutte le voci collegate al repo. Errori di GitHub → 502 col messaggio fisso.
 */
export async function refreshPlanIssues(appId: number, userId: number): Promise<PlanIssuesSummary> {
  const { repo, installationId } = await issueTarget(appId, userId);
  const [oldest] = await db
    .select({ since: min(analysisItemsTable.issueCheckedAt), count: count() })
    .from(analysisItemsTable)
    .where(linkedTo(appId, repo));
  if (oldest && oldest.count > 0) {
    // issueTarget garantisce la configurazione
    const cfg = githubConfig()!;
    let states: Awaited<ReturnType<typeof listCaselloIssues>>;
    try {
      const token = await issuesToken(cfg, installationId, repo);
      states = await listCaselloIssues(cfg, token, repo, oldest.since ?? null);
    } catch (e) {
      if (e instanceof IssueError) throw new PlanIssuesError(502, e.message);
      throw e;
    }
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [number, { state, stateReason }] of states) {
        await tx
          .update(analysisItemsTable)
          .set({ issueState: state, issueStateReason: stateReason })
          .where(and(linkedTo(appId, repo), eq(analysisItemsTable.issueNumber, number)));
      }
      await tx.update(analysisItemsTable).set({ issueCheckedAt: now }).where(linkedTo(appId, repo));
    });
  }
  return planIssuesSummary(appId, userId);
}
