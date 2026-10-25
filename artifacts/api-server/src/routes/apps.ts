import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, appsTable, agentsTable, githubInstallationsTable } from "@workspace/db";
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
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

interface ConnectionFields {
  baseUrl?: string;
  internalBaseUrl?: string | null;
  userAuth?: AuthConfig | null;
  serviceAuth?: AuthConfig | null;
}

/**
 * Collegamento all'app verificato al salvataggio con le stesse regole dell'esecutore: un
 * indirizzo o un header non validi farebbero fallire ogni chiamata dei tool. Controlla solo i
 * campi presenti; restituisce il primo errore ("<campo>: <motivo>") o null.
 */
function connectionError(body: ConnectionFields): string | null {
  for (const field of ["baseUrl", "internalBaseUrl"] as const) {
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
  return null;
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
  const { serviceSecret, sourceToken, ...parsed } = parseRequest(CreateAppBody, req.body);
  const body = normalizeSources(parsed);
  const invalid = connectionError(body) ?? sourceError(body);
  if (invalid) {
    res.status(400).json({ error: invalid });
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
  const body = normalizeSources(parsed);
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
  const [app] = await db.delete(appsTable).where(eq(appsTable.id, id)).returning();
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.status(204).end();
});

export default router;
