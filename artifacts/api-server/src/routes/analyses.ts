import express, { Router, type IRouter, type RequestHandler } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  analysesTable,
  analysisItemsTable,
  appsTable,
  type AnalysisItem,
  type App,
} from "@workspace/db";
import {
  ListAnalysesParams,
  ListAnalysesResponse,
  StartAnalysisParams,
  StartAnalysisBody,
  StartAnalysisResponse,
  StartZipAnalysisParams,
  StartZipAnalysisQueryParams,
  StartZipAnalysisResponse,
  GetAnalysisParams,
  GetAnalysisResponse,
  ExportAnalysisIssuesParams,
  ExportAnalysisIssuesQueryParams,
  ExportAnalysisIssuesResponse,
  UpdateAnalysisItemParams,
  UpdateAnalysisItemBody,
  UpdateAnalysisItemResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { AVAILABLE_MODELS } from "../lib/models";
import { ModelChoiceError, chooseByName, chooseOwnModel, type ModelChoice } from "../lib/ai/choice";
import { isUniqueViolation } from "../lib/pg-errors";
import { ANALYSIS_DEFAULT_MAX_TOKENS, startAnalysis } from "../lib/architect/run-analysis";
import { ApplyError, applyItem } from "../lib/architect/apply";
import { exportIssues } from "../lib/architect/issues";
import { ITEM_SCHEMAS, PHASES, type AnalysisChapter } from "../lib/architect/schemas";
import { SOURCE_LIMITS } from "../lib/architect/source-tree";
import { runRateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";
import { INSTALLATION_NOT_YOURS, userHasInstallation } from "./apps";
import { toPublicAnalysis, toPublicAnalysisDetail, toPublicItem } from "./serializers";

// Route dell'architetto: avvio delle analisi (sorgenti dell'app o zip caricato), dettaglio,
// revisione degli elementi della proposta ed esportazione delle issue.

/**
 * Lettura dell'archivio zip come Buffer, solo in memoria. Si monta soltanto sulla route dello zip:
 * oltre `limitBytes` il parser lancia `entity.too.large` e l'error handler risponde 413.
 */
export function zipUpload(limitBytes: number = SOURCE_LIMITS.maxZipBytes): RequestHandler {
  return express.raw({ type: ["application/zip", "application/octet-stream"], limit: limitBytes });
}

/** Capitoli nell'ordine delle fasi che li producono (catalogo, agenti, completamento, evoluzione). */
const PHASE_CHAPTERS: Record<(typeof PHASES)[number], AnalysisChapter[]> = {
  map: [],
  capabilities: [],
  catalog: ["tool", "endpoint"],
  agents: ["agent", "skill"],
  completion: ["completion"],
  evolution: ["evolution"],
};
const CHAPTER_ORDER: AnalysisChapter[] = PHASES.flatMap((phase) => PHASE_CHAPTERS[phase]);

/** Solo questi capitoli si possono rimandare: gli altri si approvano o si scartano. */
const POSTPONABLE = new Set<AnalysisChapter>(["endpoint", "completion", "evolution"]);

/** Modello ammesso: uno di quelli offerti da GET /models. Errore in italiano o null. */
function modelError(model: string): string | null {
  if (AVAILABLE_MODELS.some((m) => m.id === model)) return null;
  return `modello non disponibile: scegli tra ${AVAILABLE_MODELS.map((m) => m.id).join(", ")}`;
}

const CHOOSE_MODEL = "scegli un modello";

/**
 * Modello dell'analisi, indicato con esattamente uno tra `aiModelId` (modello dell'utente che avvia
 * o dell'account di sistema) e `model` (nome, console precedente: elenco di GET /models, collegato
 * al modello di sistema equivalente se esiste). Lancia ModelChoiceError con il messaggio per il 400.
 */
async function analysisModel(input: { aiModelId?: number; model?: string }, userId: number): Promise<ModelChoice> {
  const { aiModelId, model } = input;
  if ((aiModelId === undefined) === (model === undefined)) throw new ModelChoiceError(CHOOSE_MODEL);
  if (aiModelId !== undefined) return chooseOwnModel(aiModelId, userId);
  const invalid = modelError(model!);
  if (invalid) throw new ModelChoiceError(invalid);
  return chooseByName(model!);
}

/** L'app ha già un'analisi `queued`/`running` (indice unico parziale `analyses_one_active_per_app`). */
class AnalysisBusyError extends Error {}

/**
 * Crea l'analisi `queued` e la avvia in background. `startAnalysis` non lancia mai: registra da sé
 * ogni errore sulla riga dell'analisi. Lo zip resta solo in memoria (mai su disco né nei log).
 */
async function createAndStart(app: App, choice: ModelChoice, maxTokens: number | undefined, zip?: Uint8Array) {
  let row;
  try {
    [row] = await db
      .insert(analysesTable)
      .values({
        appId: app.id,
        model: choice.model,
        aiModelId: choice.aiModelId,
        maxTokens: maxTokens ?? ANALYSIS_DEFAULT_MAX_TOKENS,
        // Valore iniziale: l'orchestratore lo sovrascrive con le sorgenti usate davvero
        sources: { code: zip ? "zip" : app.sourceType, openapi: false, description: !!app.functionalDescription?.trim() },
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "analyses_one_active_per_app")) throw new AnalysisBusyError();
    throw err;
  }
  void startAnalysis(row!.id, zip ? { zip } : undefined);
  return row!;
}

const BUSY_MESSAGE = "C'è già un'analisi in corso per questa app: attendi che finisca";

async function findApp(id: number): Promise<App | undefined> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id)).limit(1);
  return app;
}

/** Elemento con l'app della sua analisi: l'app non arriva mai dal client. */
async function findItem(id: number): Promise<{ item: AnalysisItem; appId: number } | undefined> {
  const [row] = await db
    .select({ item: analysisItemsTable, appId: analysesTable.appId })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(eq(analysisItemsTable.id, id))
    .limit(1);
  return row;
}

/** Conflitto con lo stato corrente dell'elemento (già approvato, non più in attesa…): 409. */
class ItemConflictError extends Error {}

export function createAnalysesRouter(opts: { zipLimitBytes?: number } = {}): IRouter {
  const router: IRouter = Router();

  router.get("/apps/:id/analyses", async (req, res) => {
    const { id } = parseRequest(ListAnalysesParams, req.params);
    if (!(await findApp(id))) {
      res.status(404).json({ error: "App non trovata" });
      return;
    }
    const rows = await db
      .select()
      .from(analysesTable)
      .where(eq(analysesTable.appId, id))
      .orderBy(desc(analysesTable.createdAt), desc(analysesTable.id));
    res.json(ListAnalysesResponse.parse(rows.map(toPublicAnalysis)));
  });

  // Avvio con le sorgenti configurate sull'app (GitHub, OpenAPI, descrizione funzionale)
  router.post("/apps/:id/analyses", runRateLimit, async (req, res) => {
    const { id } = parseRequest(StartAnalysisParams, req.params);
    const { model, aiModelId, maxTokens } = parseRequest(StartAnalysisBody, req.body);
    const app = await findApp(id);
    if (!app) {
      res.status(404).json({ error: "App non trovata" });
      return;
    }
    let choice: ModelChoice;
    try {
      choice = await analysisModel({ aiModelId, model }, currentUserId(req));
    } catch (err) {
      if (!(err instanceof ModelChoiceError)) throw err;
      res.status(400).json({ error: err.message });
      return;
    }
    if (app.sourceType === "zip") {
      res.status(400).json({ error: "Il codice di questa app arriva da un archivio: usa il caricamento dello zip" });
      return;
    }
    if (app.sourceType === "github" && !app.sourceRepo) {
      res.status(400).json({ error: "Repo GitHub mancante: impostalo nelle sorgenti dell'app" });
      return;
    }
    if (app.sourceType === "github" && app.sourceInstallationId != null) {
      // Tramite l'App: niente token manuale, ma l'installazione deve essere di chi avvia
      if (!(await userHasInstallation(currentUserId(req), app.sourceInstallationId))) {
        res.status(403).json({ error: INSTALLATION_NOT_YOURS });
        return;
      }
    } else if (app.sourceType === "github" && app.sourceTokenEnc == null) {
      res.status(400).json({ error: "token GitHub mancante: impostalo nelle sorgenti dell'app" });
      return;
    }
    try {
      const analysis = await createAndStart(app, choice, maxTokens);
      res.status(202).json(StartAnalysisResponse.parse(toPublicAnalysis(analysis)));
    } catch (err) {
      if (!(err instanceof AnalysisBusyError)) throw err;
      res.status(409).json({ error: BUSY_MESSAGE });
    }
  });

  // Avvio con il codice caricato come zip (corpo binario, solo in memoria)
  router.post(
    "/apps/:id/analyses/zip",
    runRateLimit,
    zipUpload(opts.zipLimitBytes),
    async (req, res) => {
      const { id } = parseRequest(StartZipAnalysisParams, req.params);
      const { model, aiModelId, maxTokens } = parseRequest(StartZipAnalysisQueryParams, req.query);
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: "Archivio zip mancante: invia il file come application/zip" });
        return;
      }
      const app = await findApp(id);
      if (!app) {
        res.status(404).json({ error: "App non trovata" });
        return;
      }
      let choice: ModelChoice;
      try {
        choice = await analysisModel({ aiModelId, model }, currentUserId(req));
      } catch (err) {
        if (!(err instanceof ModelChoiceError)) throw err;
        res.status(400).json({ error: err.message });
        return;
      }
      try {
        const zip = new Uint8Array(body.buffer, body.byteOffset, body.length);
        const analysis = await createAndStart(app, choice, maxTokens, zip);
        res.status(202).json(StartZipAnalysisResponse.parse(toPublicAnalysis(analysis)));
      } catch (err) {
        if (!(err instanceof AnalysisBusyError)) throw err;
        res.status(409).json({ error: BUSY_MESSAGE });
      }
    },
  );

  router.get("/analyses/:id", async (req, res) => {
    const { id } = parseRequest(GetAnalysisParams, req.params);
    const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.id, id)).limit(1);
    if (!analysis) {
      res.status(404).json({ error: "Analisi non trovata" });
      return;
    }
    const items = await db
      .select()
      .from(analysisItemsTable)
      .where(eq(analysisItemsTable.analysisId, id))
      .orderBy(asc(analysisItemsTable.position), asc(analysisItemsTable.id));
    // Capitoli nell'ordine delle fasi; dentro il capitolo per posizione (ordinamento stabile)
    items.sort((a, b) => CHAPTER_ORDER.indexOf(a.chapter) - CHAPTER_ORDER.indexOf(b.chapter));
    res.json(GetAnalysisResponse.parse({ ...toPublicAnalysisDetail(analysis), items: items.map(toPublicItem) }));
  });

  router.get("/analyses/:id/issues", async (req, res) => {
    const { id } = parseRequest(ExportAnalysisIssuesParams, req.params);
    const { chapter, status = "approved" } = parseRequest(ExportAnalysisIssuesQueryParams, req.query);
    const [analysis] = await db
      .select({ id: analysesTable.id })
      .from(analysesTable)
      .where(eq(analysesTable.id, id))
      .limit(1);
    if (!analysis) {
      res.status(404).json({ error: "Analisi non trovata" });
      return;
    }
    const items = await db
      .select()
      .from(analysisItemsTable)
      .where(
        and(
          eq(analysisItemsTable.analysisId, id),
          eq(analysisItemsTable.chapter, chapter),
          eq(analysisItemsTable.status, status),
        ),
      )
      .orderBy(asc(analysisItemsTable.position), asc(analysisItemsTable.id));
    res.json(ExportAnalysisIssuesResponse.parse(exportIssues(items, chapter)));
  });

  // Revisione di un elemento. Regole:
  // - un elemento `approved` è immutabile (409);
  // - il payload si modifica solo se `pending`, validato con lo schema del capitolo (400);
  // - `postponed` solo per endpoint/completion/evolution (400); tra pending, discarded e
  //   postponed ci si sposta liberamente;
  // - `approved` solo da `pending`: in un'unica transazione si marca l'elemento (UPDATE
  //   condizionato, che blocca la riga: una seconda approvazione concorrente trova 0 righe → 409)
  //   e si applica la proposta; un `ApplyError` annulla tutto (anche la modifica del payload) → 400.
  router.patch("/analysis-items/:id", async (req, res) => {
    const { id } = parseRequest(UpdateAnalysisItemParams, req.params);
    const body = parseRequest(UpdateAnalysisItemBody, req.body);

    const found = await findItem(id);
    if (!found) {
      res.status(404).json({ error: "Elemento non trovato" });
      return;
    }
    const { item, appId } = found;
    if (item.status === "approved") {
      res.status(409).json({ error: "Elemento già approvato: non si può più modificare" });
      return;
    }
    if (body.status === "postponed" && !POSTPONABLE.has(item.chapter)) {
      res.status(400).json({
        error: "Si possono rimandare solo gli elementi dei capitoli endpoint, completion ed evolution",
      });
      return;
    }

    let payload: unknown;
    if (body.payload !== undefined) {
      if (item.status !== "pending") {
        res.status(409).json({ error: "Si può modificare solo un elemento in attesa" });
        return;
      }
      const parsed = ITEM_SCHEMAS[item.chapter].safeParse(body.payload);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        const path = ["payload", ...issue.path].join(".");
        res.status(400).json({ error: `${path}: ${issue.message}` });
        return;
      }
      payload = parsed.data;
    }

    const changes = {
      ...(payload !== undefined ? { payload } : {}),
      ...(body.reviewNote !== undefined ? { reviewNote: body.reviewNote } : {}),
    };

    let updated: AnalysisItem;
    try {
      if (body.status === "approved") {
        updated = await db.transaction(async (tx) => {
          const [row] = await tx
            .update(analysisItemsTable)
            .set({ ...changes, status: "approved", appliedAt: new Date() })
            .where(and(eq(analysisItemsTable.id, id), eq(analysisItemsTable.status, "pending")))
            .returning();
          if (!row) throw new ItemConflictError("Si può approvare solo un elemento in attesa");
          // Un errore qui (ApplyError o violazione di unicità che ha già interrotto la
          // transazione) esce dalla callback: rollback completo, l'elemento resta `pending`
          await applyItem(row, appId, tx);
          return row;
        });
      } else {
        if (body.status === undefined && Object.keys(changes).length === 0) {
          res.json(UpdateAnalysisItemResponse.parse(toPublicItem(item)));
          return;
        }
        // Condizionato sullo stato letto: un'approvazione concorrente non viene sovrascritta
        const [row] = await db
          .update(analysisItemsTable)
          .set({ ...changes, ...(body.status !== undefined ? { status: body.status } : {}) })
          .where(and(eq(analysisItemsTable.id, id), eq(analysisItemsTable.status, item.status)))
          .returning();
        if (!row) throw new ItemConflictError("L'elemento è cambiato nel frattempo: ricarica la proposta");
        updated = row;
      }
    } catch (err) {
      if (err instanceof ApplyError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof ItemConflictError) {
        if (!(await findItem(id))) {
          res.status(404).json({ error: "Elemento non trovato" });
          return;
        }
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.json(UpdateAnalysisItemResponse.parse(toPublicItem(updated)));
  });

  return router;
}
