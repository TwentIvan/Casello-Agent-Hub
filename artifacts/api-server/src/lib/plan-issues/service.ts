import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, analysesTable, analysisItemsTable, appsTable, type AnalysisItem } from "@workspace/db";
import { githubConfig } from "../github/config";
import { IssueError, createIssue, ensureLabels, issuesToken } from "../github/issues";
import { completionData } from "../architect/issues";
import { INSTALLATION_NOT_YOURS, userHasInstallation } from "../../routes/apps";
import { creationOrder, isEligible, issueContent, issueLabels } from "./content";

/**
 * Creazione delle issue GitHub dalle voci approvate del piano (spec «dal piano alle issue», §4).
 * Ogni voce si prenota (`issue_state = 'creating'`) prima della chiamata a GitHub: due richieste
 * concorrenti sulle stesse voci non creano doppioni. Su errore la prenotazione si toglie; quelle
 * rimaste da un riavvio si azzerano all'avvio (`resetStaleIssueReservations`).
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

/** Pausa tra due creazioni: GitHub limita la creazione rapida di contenuti. */
const DEFAULT_PAUSE_MS = 1000;

export interface PlanIssuePreview {
  itemId: number;
  title: string;
  body: string;
  labels: string[];
  skipped: boolean;
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
  let created = 0;
  for (const item of items) {
    if (stopped !== null) {
      results.push({ itemId: item.id, outcome: "failed", error: stopped });
      continue;
    }
    if (!isCandidate(item) || !(await reserve(item.id))) {
      results.push({ itemId: item.id, outcome: "skipped" });
      continue;
    }
    if (created > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const content = issueContent(item, { appName, issueByKey, titleByKey });
    try {
      const issue = await createIssue(cfg, token, repo, content);
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
        .where(eq(analysisItemsTable.id, item.id));
      created++;
      if (item.chapter === "completion") issueByKey.set(completionData(item).key, issue.number);
      results.push({ itemId: item.id, outcome: "created", number: issue.number, url: issue.url });
    } catch (e) {
      await release(item.id);
      if (!(e instanceof IssueError)) throw e;
      // Un errore di repository o permesso ferma il lotto: questa voce e le restanti falliscono
      if (e.scope === "batch") stopped = e.message;
      results.push({ itemId: item.id, outcome: "failed", error: e.message });
    }
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
