import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, asc, count, eq } from "drizzle-orm";
import { db, appsTable, agentsTable, githubInstallationsTable, pendingActionsTable, teamInstancesTable } from "@workspace/db";
import {
  ListAppsResponse,
  CreateAppBody,
  CreateAppResponse,
  GetAppParams,
  GetAppResponse,
  UpdateAppParams,
  UpdateAppBody,
  UpdateAppResponse,
  DeleteAppParams,
} from "@workspace/api-zod";
import { encryptSecret } from "../lib/secrets";
import { checkAuthHeaderName, parseAppBaseUrl } from "../lib/tools/executor";
import type { AuthConfig } from "../lib/tools/types";
import { uniqueSlug, withSlugRetry } from "../lib/slug";
import { isValidGithubRepo } from "../lib/architect/sources";
import { currentUserId } from "../lib/auth";
import { GITHUB_MESSAGES, GithubError, repoInstallationId } from "../lib/github/app";
import { githubConfig } from "../lib/github/config";
import { toPublicApp } from "./serializers";
import { ModelChoiceError, type ModelChoice } from "../lib/ai/choice";
import { resolveAgentModel } from "../lib/ai/default-model";
import { isForeignKeyViolation } from "../lib/pg-errors";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

interface ConnectionFields {
  baseUrl?: string;
  internalBaseUrl?: string | null;
  mcpUrl?: string | null;
  pluginUrlTemplate?: string | null;
  userAuth?: AuthConfig | null;
  serviceAuth?: AuthConfig | null;
}

/**
 * Collegamento all'app verificato al salvataggio con le stesse regole dell'esecutore: un
 * indirizzo o un header non validi farebbero fallire ogni chiamata dei tool. Controlla solo i
 * campi presenti; restituisce il primo errore ("<campo>: <motivo>") o null.
 */
function connectionError(body: ConnectionFields): string | null {
  for (const field of ["baseUrl", "internalBaseUrl", "mcpUrl"] as const) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    const parsed = parseAppBaseUrl(value);
    if (!parsed.ok) return `${field}: ${parsed.error}`;
  }
  for (const field of ["userAuth", "serviceAuth"] as const) {
    const config = body[field];
    if (!config) continue;
    const error = checkAuthHeaderName(config.header);
    if (error) return `${field}.header: ${error}`;
  }
  if (body.pluginUrlTemplate != null) {
    const error = pluginUrlTemplateError(body.pluginUrlTemplate);
    if (error) return `pluginUrlTemplate: ${error}`;
  }
  return null;
}

const PLUGIN_URL_MAX = 500;
const PLUGIN_URL_MESSAGE = "indirizzo non valido: serve https e {refId} una sola volta";

/**
 * Template dell'indirizzo del lavoro nel servizio: 1..500 caratteri, `{refId}` una sola volta e,
 * sostituito, un URL https senza credenziali (http solo verso localhost o 127.0.0.1 fuori produzione).
 * Restituisce il motivo o null.
 */
export function pluginUrlTemplateError(value: string): string | null {
  if (value.length < 1 || value.length > PLUGIN_URL_MAX) return PLUGIN_URL_MESSAGE;
  if (value.split("{refId}").length !== 2) return PLUGIN_URL_MESSAGE;
  let url: URL;
  try {
    url = new URL(value.replace("{refId}", "1"));
  } catch {
    return PLUGIN_URL_MESSAGE;
  }
  if (url.username || url.password) return PLUGIN_URL_MESSAGE;
  if (url.protocol === "https:") return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && local && process.env["NODE_ENV"] !== "production") return null;
  return PLUGIN_URL_MESSAGE;
}

/** Template vuoto → null; assente resta assente. */
function normalizePluginUrl<T extends ConnectionFields>(body: T): T {
  if (body.pluginUrlTemplate === undefined || body.pluginUrlTemplate === null) return body;
  return { ...body, pluginUrlTemplate: body.pluginUrlTemplate.trim() === "" ? null : body.pluginUrlTemplate.trim() };
}

// ── Sorgenti dell'architetto ────────────────────────────────────────────────

/** Tetto della descrizione funzionale: finisce intera nel prompt dell'architetto. */
const MAX_FUNCTIONAL_DESCRIPTION = 20_000;

interface SourceFields {
  sourceType?: "github" | "zip" | "none";
  sourceRepo?: string | null;
  sourceBranch?: string | null;
  openapiUrl?: string | null;
  functionalDescription?: string | null;
}

/** Stringa vuota o di soli spazi → null, il resto senza spazi ai lati; assente resta assente. */
function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Repo, branch e URL dell'OpenAPI ripuliti: un campo lasciato vuoto nel modulo vale null. */
function normalizeSources<T extends SourceFields>(body: T): T {
  const result = { ...body };
  if (body.sourceRepo !== undefined) result.sourceRepo = blankToNull(body.sourceRepo);
  if (body.sourceBranch !== undefined) result.sourceBranch = blankToNull(body.sourceBranch);
  if (body.openapiUrl !== undefined) result.openapiUrl = blankToNull(body.openapiUrl);
  return result;
}

/**
 * Sorgenti dell'architetto: repo nel formato proprietario/nome, OpenAPI solo http(s), descrizione
 * entro il tetto e, con la sorgente `github`, un repo nello stato risultante (`current` = valori
 * già salvati, per la PATCH). Restituisce il primo errore ("<campo>: <motivo>") o null.
 */
function sourceError(body: SourceFields, current?: { sourceType: string; sourceRepo: string | null }): string | null {
  if (body.sourceRepo != null && !isValidGithubRepo(body.sourceRepo)) {
    return "sourceRepo: repo GitHub non valido, atteso il formato proprietario/nome";
  }
  if (body.openapiUrl != null) {
    let url: URL | null = null;
    try {
      url = new URL(body.openapiUrl);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return "openapiUrl: indirizzo non valido, sono ammessi solo http e https";
    }
  }
  if (body.functionalDescription != null && body.functionalDescription.length > MAX_FUNCTIONAL_DESCRIPTION) {
    return `functionalDescription: testo troppo lungo (massimo ${MAX_FUNCTIONAL_DESCRIPTION} caratteri)`;
  }
  const type = body.sourceType ?? current?.sourceType ?? "none";
  const repo = body.sourceRepo !== undefined ? body.sourceRepo : (current?.sourceRepo ?? null);
  if (type === "github" && !repo) {
    return "sourceRepo: obbligatorio con la sorgente github (formato proprietario/nome)";
  }
  return null;
}

/**
 * Token GitHub, senza spazi ai bordi (un a capo incollato renderebbe il token inutilizzabile):
 * stringa vuota, solo spazi o assente → invariato (alla creazione: nessun token), null →
 * cancellato, altrimenti cifrato. Il modulo della console lascia il campo vuoto per non cambiarlo.
 */
function sourceTokenChange(token: string | null | undefined): { sourceTokenEnc?: string | null } {
  if (token === null) return { sourceTokenEnc: null };
  const trimmed = token?.trim();
  if (!trimmed) return {};
  return { sourceTokenEnc: encryptSecret(trimmed) };
}

/** Messaggio della spec per un'installazione che non c'è, non è dell'utente o non vede il repo. */
export const INSTALLATION_NOT_YOURS = "installazione non trovata o non tua";

/** L'utente ha collegato quell'installazione (riga in `github_installations`). */
export async function userHasInstallation(userId: number, installationId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: githubInstallationsTable.id })
    .from(githubInstallationsTable)
    .where(and(eq(githubInstallationsTable.userId, userId), eq(githubInstallationsTable.installationId, installationId)))
    .limit(1);
  return !!row;
}

interface InstallationState {
  sourceType: string;
  sourceRepo: string | null;
  sourceInstallationId: number;
}

/**
 * Sorgente tramite l'installazione della GitHub App, sullo stato risultante: GitHub configurato,
 * sorgente `github` con un repo, installazione collegata dall'utente e che vede quel repo (chiesto a
 * GitHub con il JWT dell'App). Restituisce stato HTTP ed errore, o null se va bene.
 */
async function installationError(userId: number, state: InstallationState): Promise<{ status: 400 | 502; error: string } | null> {
  const cfg = githubConfig();
  if (!cfg) return { status: 400, error: GITHUB_MESSAGES.notConfigured };
  const id = state.sourceInstallationId;
  if (!Number.isSafeInteger(id) || id <= 0 || state.sourceType !== "github" || !state.sourceRepo) {
    return { status: 400, error: INSTALLATION_NOT_YOURS };
  }
  if (!(await userHasInstallation(userId, id))) return { status: 400, error: INSTALLATION_NOT_YOURS };
  try {
    if ((await repoInstallationId(cfg, state.sourceRepo)) !== id) return { status: 400, error: INSTALLATION_NOT_YOURS };
  } catch (err) {
    if (!(err instanceof GithubError)) throw err;
    if (err.message === GITHUB_MESSAGES.unavailable) return { status: 502, error: GITHUB_MESSAGES.unavailable };
    if (err.message === GITHUB_MESSAGES.notConfigured) return { status: 400, error: GITHUB_MESSAGES.notConfigured };
    return { status: 400, error: INSTALLATION_NOT_YOURS };
  }
  return null;
}

router.get("/apps", async (_req, res) => {
  const apps = await db.select().from(appsTable).orderBy(asc(appsTable.id));
  res.json(ListAppsResponse.parse(apps.map(toPublicApp)));
});

// Creazione dell'app e del suo agente generale in un'unica transazione. Lo slug segue la regola
// della migrazione, che in caso di collisione usa l'id: si inserisce con uno slug provvisorio
// univoco e lo si sostituisce appena noto l'id. Se una creazione concorrente prende lo stesso slug,
// la transazione fallisce sulla unique e si riprova da capo (withSlugRetry).
router.post("/apps", async (req, res) => {
  const { serviceSecret, sourceToken, generalAgentAiModelId, ...parsed } = parseRequest(CreateAppBody, req.body);
  const body = normalizePluginUrl(normalizeSources(parsed));
  const invalid = connectionError(body) ?? sourceError(body);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  // Modello dell'agente generale: scelto, poi il predefinito dell'utente, poi nessuno
  let generalModel: ModelChoice;
  try {
    generalModel = await resolveAgentModel(currentUserId(req), generalAgentAiModelId);
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    res.status(400).json({ error: err.message });
    return;
  }
  if (body.sourceInstallationId != null) {
    const failure = await installationError(currentUserId(req), {
      sourceType: body.sourceType ?? "none",
      sourceRepo: body.sourceRepo ?? null,
      sourceInstallationId: body.sourceInstallationId,
    });
    if (failure) {
      res.status(failure.status).json({ error: failure.error });
      return;
    }
  }
  const serviceSecretEnc = serviceSecret !== undefined ? encryptSecret(serviceSecret) : null;
  const sourceTokenEnc = sourceTokenChange(sourceToken).sourceTokenEnc ?? null;

  const app = await withSlugRetry(() => db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(appsTable)
      .values({ ...body, slug: `tmp-${randomUUID()}`, serviceSecretEnc, sourceTokenEnc })
      .returning();
    const slug = await uniqueSlug(body.name, inserted!.id, async (candidate) => {
      const [row] = await tx
        .select({ id: appsTable.id })
        .from(appsTable)
        .where(eq(appsTable.slug, candidate))
        .limit(1);
      return !!row;
    });
    const [created] = await tx.update(appsTable).set({ slug }).where(eq(appsTable.id, inserted!.id)).returning();
    await tx.insert(agentsTable).values({
      appId: created!.id,
      name: `${created!.name} – generale`,
      role: "general",
      status: "draft",
      ...generalModel,
    });
    return created!;
  }));

  res.status(201).json(CreateAppResponse.parse(toPublicApp(app)));
});

router.get("/apps/:id", async (req, res) => {
  const { id } = parseRequest(GetAppParams, req.params);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.json(GetAppResponse.parse(toPublicApp(app)));
});

router.patch("/apps/:id", async (req, res) => {
  const { id } = parseRequest(UpdateAppParams, req.params);
  const { serviceSecret, sourceToken, ...parsed } = parseRequest(UpdateAppBody, req.body);
  const body = normalizePluginUrl(normalizeSources(parsed));
  const [current] = await db
    .select({
      sourceType: appsTable.sourceType,
      sourceRepo: appsTable.sourceRepo,
      sourceInstallationId: appsTable.sourceInstallationId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, id))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  const invalid = connectionError(body) ?? sourceError(body, current);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  // Installazione nello stato risultante: lasciando github si azzera da sola. Si ricontrolla con
  // GitHub solo se cambia tipo, repo o installazione (una PATCH del nome non chiama GitHub).
  const type = body.sourceType ?? current.sourceType;
  const repo = body.sourceRepo !== undefined ? body.sourceRepo : current.sourceRepo;
  const installationId =
    body.sourceInstallationId !== undefined
      ? body.sourceInstallationId
      : type === "github"
        ? current.sourceInstallationId
        : null;
  const sourceChanged =
    type !== current.sourceType || repo !== current.sourceRepo || installationId !== current.sourceInstallationId;
  if (installationId != null && sourceChanged) {
    const failure = await installationError(currentUserId(req), { sourceType: type, sourceRepo: repo, sourceInstallationId: installationId });
    if (failure) {
      res.status(failure.status).json({ error: failure.error });
      return;
    }
  }
  // serviceSecret: stringa → cifrato e salvato; null → cancellato; assente → invariato
  const secretChange =
    serviceSecret === undefined
      ? {}
      : { serviceSecretEnc: serviceSecret === null ? null : encryptSecret(serviceSecret) };
  const tokenChange = sourceTokenChange(sourceToken);
  const [app] = await db
    .update(appsTable)
    .set({ ...body, sourceInstallationId: installationId, ...secretChange, ...tokenChange, updatedAt: new Date() })
    .where(eq(appsTable.id, id))
    .returning();
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.json(UpdateAppResponse.parse(toPublicApp(app)));
});

router.delete("/apps/:id", async (req, res) => {
  const { id } = parseRequest(DeleteAppParams, req.params);
  // Un'app che è il lavoro di riferimento di una squadra non si elimina (`team_instances.ref_app_id` è RESTRICT)
  const teamsMessage = (n: number) => `l'app è il lavoro di riferimento di ${n} squadre`;
  const [{ n: teams } = { n: 0 }] = await db.select({ n: count() }).from(teamInstancesTable).where(eq(teamInstancesTable.refAppId, id));
  if (teams > 0) {
    res.status(409).json({ error: teamsMessage(teams) });
    return;
  }
  // Lo storico della coda segue l'app: va tolto prima, perché `pending_actions.tool_id` è RESTRICT
  // e bloccherebbe la cascata dell'app verso i suoi tool
  let app;
  try {
    app = await db.transaction(async (tx) => {
      await tx.delete(pendingActionsTable).where(eq(pendingActionsTable.appId, id));
      const [deleted] = await tx.delete(appsTable).where(eq(appsTable.id, id)).returning();
      return deleted;
    });
  } catch (err) {
    // Una squadra creata tra il controllo e la cancellazione: stessa risposta
    if (!isForeignKeyViolation(err)) throw err;
    const [{ n: now } = { n: 0 }] = await db.select({ n: count() }).from(teamInstancesTable).where(eq(teamInstancesTable.refAppId, id));
    res.status(409).json({ error: teamsMessage(now) });
    return;
  }
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.status(204).end();
});

export default router;
