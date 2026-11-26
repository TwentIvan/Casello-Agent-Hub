import type { Request, RequestHandler, Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import type { Character } from "../lib/memory/types";

/** Contatore a finestra fissa per chiave, in memoria. */
export function fixedWindowCounter({ limit, windowMs }: { limit: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Azzera tutte le finestre (solo per i test). */
    reset(): void {
      hits.clear();
    },
    /** Conta una richiesta: `ok` false oltre il limite, con i secondi da attendere. */
    consume(k: string): { ok: boolean; retryAfterSec: number } {
      const now = Date.now();

      // Pulizia delle finestre scadute, così la mappa non cresce senza limite.
      if (hits.size > 1000) {
        for (const [key, entry] of hits) {
          if (entry.resetAt <= now) hits.delete(key);
        }
      }

      let entry = hits.get(k);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(k, entry);
      }
      entry.count++;
      return { ok: entry.count <= limit, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    },
  };
}

function middlewareFor(
  counter: ReturnType<typeof fixedWindowCounter>,
  key: (req: Request) => string,
  reject?: (res: Response) => void,
): RequestHandler {
  return (req, res, next) => {
    const out = counter.consume(key(req));
    if (!out.ok) {
      res.setHeader("Retry-After", out.retryAfterSec);
      if (reject) reject(res);
      else res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
      return;
    }
    next();
  };
}

// Rate limit in memoria, a finestra fissa per chiave (di default l'IP): si azzera al riavvio e con più repliche
// ognuna avrebbe il suo contatore. L'avvio di run e analisi usa i contatori persistenti qui sotto.
export function rateLimit({
  limit,
  windowMs,
  key = (req) => req.ip ?? "unknown",
}: {
  limit: number;
  windowMs: number;
  /** Chiave del contatore (default: IP del client). */
  key?: (req: Request) => string;
}): RequestHandler {
  return middlewareFor(fixedWindowCounter({ limit, windowMs }), key);
}

// Contatori persistenti in Postgres (`rate_limit_counters`), a finestra fissa allineata (inizio = multiplo di
// `windowMs`) e per utente: non si azzerano a ogni deploy e valgono anche con più container API. Un errore del DB
// (o un utente che non esiste più) ricade su un contatore in memoria con le stesse regole, così il limite non si spegne.
const COUNTER_RETENTION_MS = 24 * 60 * 60_000;
const COUNTER_SWEEP_EVERY_MS = 10 * 60_000;
let lastCounterSweep = 0;

function sweepOldCounters(now: number): void {
  if (now - lastCounterSweep < COUNTER_SWEEP_EVERY_MS) return;
  lastCounterSweep = now;
  pool.query("DELETE FROM rate_limit_counters WHERE window_start < $1", [new Date(now - COUNTER_RETENTION_MS)]).catch((err: unknown) => {
    logger.warn({ errName: err instanceof Error ? err.name : "unknown" }, "Pulizia dei contatori del rate limit non riuscita");
  });
}

export function persistentWindowCounter({ name, limit, windowMs }: { name: string; limit: number; windowMs: number }) {
  const fallback = fixedWindowCounter({ limit, windowMs });
  return {
    /** Azzera il contatore di riserva in memoria (solo per i test). */
    resetFallback(): void {
      fallback.reset();
    },
    /** Conta una richiesta dell'utente (`sub` distingue sotto-contatori, es. l'id del token). */
    async consume(userId: number, sub = ""): Promise<{ ok: boolean; retryAfterSec: number }> {
      const bucket = sub ? `${name}:${sub}` : name;
      const now = Date.now();
      const start = Math.floor(now / windowMs) * windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((start + windowMs - now) / 1000));
      try {
        const r = await pool.query<{ count: number }>(
          `INSERT INTO rate_limit_counters (user_id, bucket, window_start, count) VALUES ($1, $2, $3, 1)
           ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
           RETURNING count`,
          [userId, bucket, new Date(start)],
        );
        sweepOldCounters(now);
        return { ok: Number(r.rows[0]?.count ?? 1) <= limit, retryAfterSec };
      } catch (err) {
        logger.warn({ errName: err instanceof Error ? err.name : "unknown", bucket: name }, "Rate limit persistente non disponibile: contatore in memoria");
        return fallback.consume(`user:${userId}:${bucket}`);
      }
    },
  };
}

function persistentMiddleware(
  counter: ReturnType<typeof persistentWindowCounter>,
  sub: (req: Request) => string,
  withoutUser: RequestHandler,
): RequestHandler {
  return async (req, res, next) => {
    if (req.userId === undefined) {
      withoutUser(req, res, next);
      return;
    }
    const out = await counter.consume(req.userId, sub(req));
    if (!out.ok) {
      res.setHeader("Retry-After", out.retryAfterSec);
      res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
      return;
    }
    next();
  };
}

// Ogni avvio consuma token sugli account AI: massimo 10 al minuto per utente (contatore persistente), con un solo
// contatore condiviso da POST /agents/:id/runs (con sessione o pannello incorporato) e dall'avvio delle analisi.
// Senza utente (non dovrebbe succedere dietro requireAuth) vale il vecchio limite in memoria per IP.
const runStartCounter = persistentWindowCounter({ name: "run_start", limit: 10, windowMs: 60_000 });
const runStartByIp = rateLimit({ limit: 10, windowMs: 60_000 });
export const runRateLimit = persistentMiddleware(runStartCounter, () => "", runStartByIp);

// Avvio delle run con un token personale: 60 al minuto per token (id del token, contatore persistente dell'utente del
// token) al posto del limite di 10; con la sessione (o il pannello incorporato, senza id di token) vale `runRateLimit`.
// Le analisi restano su `runRateLimit`.
const tokenRunStartCounter = persistentWindowCounter({ name: "run_start_token", limit: 60, windowMs: 60_000 });
const tokenRunByIp = rateLimit({ limit: 60, windowMs: 60_000, key: (req) => `token:${req.auth?.kind === "token" ? req.auth.tokenId : ""}` });
const tokenRunRateLimit = persistentMiddleware(
  tokenRunStartCounter,
  (req) => String(req.auth?.kind === "token" ? req.auth.tokenId : ""),
  tokenRunByIp,
);
export const runTriggerRateLimit: RequestHandler = (req, res, next) => {
  if (req.auth?.kind === "token" && req.auth.tokenId !== null) return tokenRunRateLimit(req, res, next);
  return runRateLimit(req, res, next);
};

/** Solo per i test: contatori persistenti dell'avvio di run e analisi. */
export const runStartCounters = { session: runStartCounter, token: tokenRunStartCounter };

// L'annullamento di una run non consuma token: ha un contatore proprio, più largo, così non
// compete con avvio e ripresa.
export const cancelRateLimit = rateLimit({ limit: 30, windowMs: 60_000 });

// Issue GitHub dal piano, per utente (le route passano da requireAuth): 5 creazioni al minuto
// (le anteprime non contano: vedi la route) e 6 aggiornamenti di stato al minuto.
const byUser = (req: Request) => (req.userId !== undefined ? `user:${req.userId}` : (req.ip ?? "unknown"));
export const issueCreateRateLimit = rateLimit({ limit: 5, windowMs: 60_000, key: byUser });
export const issueRefreshRateLimit = rateLimit({ limit: 6, windowMs: 60_000, key: byUser });

// Istruzioni a una run in corso (issue #119): 10 al minuto per utente.
export const runMessageRateLimit = rateLimit({ limit: 10, windowMs: 60_000, key: byUser });

// Allegati delle chat (issue #120): 20 caricamenti al minuto per utente.
export const chatAttachmentUploadRateLimit = rateLimit({ limit: 20, windowMs: 60_000, key: byUser });

// Aggiornamento del catalogo dal server MCP di un'app: 6 al minuto per utente.
export const mcpRefreshRateLimit = rateLimit({ limit: 6, windowMs: 60_000, key: byUser });
// «Prova» degli inneschi: chiama il tool dell'app, 6 al minuto per utente (configurazione e innesco salvato insieme).
export const triggerTestRateLimit = rateLimit({ limit: 6, windowMs: 60_000, key: byUser });

// Approvazione e rifiuto delle azioni in coda: 20 al minuto per utente. Un solo contatore condiviso dalle route
// `POST /pending-actions/:number/approve|reject` e dagli strumenti MCP `approva`/`rifiuta` (`consumeActionDecision`).
const actionDecideCounter = fixedWindowCounter({ limit: 20, windowMs: 60_000 });
export const actionDecideRateLimit = middlewareFor(actionDecideCounter, byUser);

/** Conta una decisione sulla coda dell'utente (stesso budget delle route): false se il limite è raggiunto. */
export function consumeActionDecision(userId: number): boolean {
  return actionDecideCounter.consume(`user:${userId}`).ok;
}

// Token personali su /api: 120 richieste al minuto per token (chiave: id del token), in aggiunta ai
// limiti per utente o IP. Lo applica requireAuth solo alle richieste autenticate con un token.
export const tokenRateLimit = rateLimit({
  limit: 120,
  windowMs: 60_000,
  key: (req) =>
    req.auth?.kind === "token" ? (req.auth.via === "embed" ? `embed:${req.auth.grantId}` : `token:${req.auth.tokenId}`) : "token:?",
});

// Messaggi al capo di una squadra (ognuno fa partire un turno che consuma token): 10 al minuto per utente.
// Un solo contatore condiviso da `POST …/messages` e dallo strumento MCP `invia_al_capo` (`consumeTeamMessage`).
const teamMessageCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });
export const teamMessageRateLimit = middlewareFor(teamMessageCounter, byUser);

/** Conta un messaggio al capo dell'utente (stesso budget della route): false se il limite è raggiunto. */
export function consumeTeamMessage(userId: number): boolean {
  return teamMessageCounter.consume(`user:${userId}`).ok;
}

// «Aggiorna ora» della sintesi dell'architettura (ogni richiesta può far partire una generazione con un modello): 6 al minuto per utente.
const architectureRefreshCounter = fixedWindowCounter({ limit: 6, windowMs: 60_000 });

/** Conta un «Aggiorna ora» dell'utente: false se il limite è raggiunto. */
export function consumeArchitectureRefresh(userId: number): boolean {
  return architectureRefreshCounter.consume(`user:${userId}`).ok;
}

// «Controlla ora» di una nuova app da zero: 6 al minuto per utente.
const bootstrapHealthCheckCounter = fixedWindowCounter({ limit: 6, windowMs: 60_000 });

/** Conta un controllo di healthz richiesto dall'utente: false se il limite è raggiunto. */
export function consumeBootstrapHealthCheck(userId: number): boolean {
  return bootstrapHealthCheckCounter.consume(`user:${userId}`).ok;
}

/** Solo per i test: azzera il contatore del controllo di healthz. */
export function resetBootstrapHealthCheckLimit(): void {
  bootstrapHealthCheckCounter.reset();
}

// «Avvia ora» di un giro del ciclo di evoluzione (ogni giro è un'analisi a pagamento): 2 all'ora per App.
const evolutionRunNowCounter = fixedWindowCounter({ limit: 2, windowMs: 3600_000 });

/** Conta un «Avvia ora» dell'App: false se il limite è raggiunto. */
export function consumeEvolutionRunNow(appId: number): boolean {
  return evolutionRunNowCounter.consume(`app:${appId}`).ok;
}

/** Solo per i test: azzera il contatore di «Avvia ora». */
export function resetEvolutionRunNowLimit(): void {
  evolutionRunNowCounter.reset();
}

/** Solo per i test: azzera il contatore di «Aggiorna ora». */
export function resetArchitectureRefreshLimit(): void {
  architectureRefreshCounter.reset();
}

// Messaggi a Lucius nella chat di squadra (ognuno fa partire un turno che consuma token): 10 al minuto per utente,
// contatore proprio (non condiviso con i messaggi al capo né con la chat del piano).
const teamChatMessageCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });

/** Conta un messaggio della chat di squadra dell'utente: false se il limite è raggiunto. */
export function consumeTeamChatMessage(userId: number): boolean {
  return teamChatMessageCounter.consume(`user:${userId}`).ok;
}

// Messaggi ad Alfred e Lucius nelle conversazioni dei personaggi: 10 al minuto per utente e personaggio, contatori
// propri (non condivisi con la chat del piano né con quella di squadra).
const characterMessageCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });

/** Conta un messaggio dell'utente al personaggio: false se il limite è raggiunto. */
export function consumeCharacterMessage(userId: number, character: Character): boolean {
  return characterMessageCounter.consume(`${character}:user:${userId}`).ok;
}

// Scritture delle istruzioni personali dei personaggi (salvataggio e ripristino): 20 al minuto per utente.
const instructionWriteCounter = fixedWindowCounter({ limit: 20, windowMs: 60_000 });

/** Conta una scrittura delle istruzioni personali: false se il limite è raggiunto. */
export function consumeInstructionWrite(userId: number): boolean {
  return instructionWriteCounter.consume(`user:${userId}`).ok;
}

/** Solo per i test: azzera il contatore delle scritture delle istruzioni personali. */
export function resetInstructionWriteLimit(): void {
  instructionWriteCounter.reset();
}

// «Ferma» sui turni delle chat (personaggi, piano, squadra): 30 al minuto per utente, un solo contatore.
const turnStopCounter = fixedWindowCounter({ limit: 30, windowMs: 60_000 });

/** Conta una richiesta di interruzione di un turno di chat dell'utente: false se il limite è raggiunto. */
export function consumeTurnStop(userId: number): boolean {
  return turnStopCounter.consume(`user:${userId}`).ok;
}

/** Azzera i limiti dei messaggi delle chat dei personaggi e di squadra e di «Ferma» (solo per i test). */
export function resetChatTurnLimits(): void {
  teamChatMessageCounter.reset();
  characterMessageCounter.reset();
  turnStopCounter.reset();
}

// Protocollo dei nodi (/api/node, dopo requireNodeToken): heartbeat e claim 6 al minuto per nodo (contatori
// separati), ping 4 al minuto per compito dello stesso nodo.
const byNode = (req: Request) => `node:${req.node?.id ?? "?"}`;
export const nodeHeartbeatRateLimit = rateLimit({ limit: 6, windowMs: 60_000, key: byNode });
// Richiesta di diagnosi dalla console: 6 all'ora per nodo (e utente)
export const nodeDiagnosticsRequestRateLimit = rateLimit({
  limit: 6,
  windowMs: 3600_000,
  key: (req) => `node-diagnostics:${req.userId ?? "?"}:${String(req.params["id"] ?? "?")}`,
});
export const nodeClaimRateLimit = rateLimit({ limit: 6, windowMs: 60_000, key: byNode });
export const nodePingRateLimit = rateLimit({
  limit: 4,
  windowMs: 60_000,
  key: (req) => `${byNode(req)}:task:${String(req.params["id"] ?? "?")}`,
});
// Token d'installazione per Git del compito: 10 al minuto per compito dello stesso nodo.
export const nodeGitTokenRateLimit = rateLimit({
  limit: 10,
  windowMs: 60_000,
  key: (req) => `${byNode(req)}:git:${String(req.params["id"] ?? "?")}`,
});
// Turni delegati al nodo: presa (attesa lunga) 40 al minuto per nodo, contatore separato da heartbeat e claim dei
// compiti; ping 6 al minuto per turno dello stesso nodo.
export const nodeTurnClaimRateLimit = rateLimit({ limit: 40, windowMs: 60_000, key: byNode });
export const nodeTurnPingRateLimit = rateLimit({
  limit: 6,
  windowMs: 60_000,
  key: (req) => `${byNode(req)}:turn:${String(req.params["id"] ?? "?")}`,
});

// Registrazione dinamica dei client OAuth del connettore: 10 al minuto per IP.
export const oauthRegisterRateLimit = rateLimit({ limit: 10, windowMs: 60_000 });
// ...e al massimo 50 al giorno per IP (finestra di 24 ore); si monta dopo quello al minuto.
export const oauthRegisterDailyRateLimit = rateLimit({ limit: 50, windowMs: 24 * 3600_000 });

// Autorizzazione OAuth (GET e POST /oauth/authorize): 20 al minuto per utente della sessione, per IP senza sessione.
export const oauthAuthorizeRateLimit = rateLimit({
  limit: 20,
  windowMs: 60_000,
  key: (req) => (req.session?.userId !== undefined ? `user:${req.session.userId}` : (req.ip ?? "unknown")),
});

// Token endpoint OAuth: 30 al minuto per client_id del corpo e IP (per solo IP se il client_id manca).
export const oauthTokenRateLimit: RequestHandler = middlewareFor(
  fixedWindowCounter({ limit: 30, windowMs: 60_000 }),
  (req) => {
    const id = (req.body as { client_id?: unknown } | undefined)?.client_id;
    const ip = req.ip ?? "unknown";
    return typeof id === "string" && id.length > 0 && id.length <= 2000 ? `client:${id}:ip:${ip}` : `ip:${ip}`;
  },
  (res) => res.status(429).json({ error: "slow_down", error_description: "troppe richieste: riprova tra poco" }),
);

// Avvio delle sessioni di Alfred (ognuna crea un token temporaneo di Gemini): 10 al minuto per utente.
const alfredSessionCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });

/** Conta un avvio di sessione di Alfred dell'utente: false se il limite è raggiunto. */
export function consumeAlfredSession(userId: number): boolean {
  return alfredSessionCounter.consume(`user:${userId}`).ok;
}

// Strumenti di Alfred (ogni chiamata di Gemini Live passa di qui): 60 al minuto per utente.
const alfredToolCounter = fixedWindowCounter({ limit: 60, windowMs: 60_000 });

/** Conta una chiamata di strumento di Alfred dell'utente: false se il limite è raggiunto. */
export function consumeAlfredTool(userId: number): boolean {
  return alfredToolCounter.consume(`user:${userId}`).ok;
}

// Novità di Alfred a voce (sondaggio periodico del browser): 30 al minuto per utente.
const alfredNotificationsCounter = fixedWindowCounter({ limit: 30, windowMs: 60_000 });

/** Conta una lettura delle novità di Alfred dell'utente: false se il limite è raggiunto. */
export function consumeAlfredNotifications(userId: number): boolean {
  return alfredNotificationsCounter.consume(`user:${userId}`).ok;
}

// Richieste di Alfred ai Responsabili di prodotto: 6 al minuto per utente (ogni richiesta avvia una run con un modello).
const leadRequestCounter = fixedWindowCounter({ limit: 6, windowMs: 60_000 });

/** Conta una richiesta di Alfred a un Responsabile di prodotto: false se il limite è raggiunto. */
export function consumeLeadRequest(userId: number): boolean {
  return leadRequestCounter.consume(`user:${userId}`).ok;
}

// Messaggi della chat con il Responsabile di Botcave: 10 al minuto per utente (ogni messaggio avvia una run).
const leadChatCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });

/** Conta un messaggio della chat con il Responsabile: false se il limite è raggiunto. */
export function consumeLeadChatMessage(userId: number): boolean {
  return leadChatCounter.consume(`user:${userId}`).ok;
}

const embedStatusCounter = fixedWindowCounter({ limit: 60, windowMs: 60_000 });

/** Conta una lettura dello stato del pannello incorporato (chiave `embed:<grantId>` o `user:<id>`): false se il limite è raggiunto. */
export function consumeEmbedStatus(key: string): boolean {
  return embedStatusCounter.consume(key).ok;
}

/** Azzera il limite dello stato del pannello (solo per i test). */
export function resetEmbedStatusLimits(): void {
  embedStatusCounter.reset();
}

// Webhook in entrata degli inneschi (pubblici). Due limiti, entrambi con `Retry-After: 60`:
// - 120 al minuto per IP, prima del parser del corpo (conta anche le richieste non autenticate);
// - 60 al minuto per innesco, contato da `handleWebhook` solo DOPO il controllo di segreto e firma: chi non conosce il
//   segreto non può esaurire il limite di un innesco altrui.
const WEBHOOK_RETRY_AFTER_SEC = 60;
const webhookIpCounter = fixedWindowCounter({ limit: 120, windowMs: 60_000 });
export const webhookIpRateLimit: RequestHandler = (req, res, next) => {
  if (!webhookIpCounter.consume(`ip:${req.ip ?? "unknown"}`).ok) {
    res.setHeader("Retry-After", WEBHOOK_RETRY_AFTER_SEC);
    res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
    return;
  }
  next();
};

const webhookTriggerCounter = fixedWindowCounter({ limit: 60, windowMs: 60_000 });
/** Conta una richiesta autenticata (segreto e firma validi) di un innesco: false oltre 60 al minuto. */
export function consumeWebhookTrigger(triggerId: number): boolean {
  return webhookTriggerCounter.consume(`hook:${triggerId}`).ok;
}

// Abbinamento dei nodi dal browser. `start` (pubblica): 10 al minuto per IP; `poll` (pubblica): 30 al minuto per
// richiesta (`pairingId`, o IP se manca); route dell'account: 20 al minuto per utente, un solo contatore per le tre.
const nodePairingStartCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });
const nodePairingPollCounter = fixedWindowCounter({ limit: 30, windowMs: 60_000 });
const nodePairingAccountCounter = fixedWindowCounter({ limit: 20, windowMs: 60_000 });
export const nodePairingStartLimit = middlewareFor(nodePairingStartCounter, (req) => `ip:${req.ip ?? "unknown"}`);
export const nodePairingPollLimit = middlewareFor(nodePairingPollCounter, (req) => {
  const id = (req.body as { pairingId?: unknown } | undefined)?.pairingId;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? `pairing:${id}` : `ip:${req.ip ?? "unknown"}`;
});
export const nodePairingAccountLimit = middlewareFor(nodePairingAccountCounter, byUser);

/** Azzera i contatori dell'abbinamento (solo per i test). */
export function resetNodePairingLimits(): void {
  nodePairingStartCounter.reset();
  nodePairingPollCounter.reset();
  nodePairingAccountCounter.reset();
}

// Lettura di pagine web da parte di Lucius e Alfred: 20 al minuto per utente, un solo contatore per i due personaggi.
const webReadCounter = fixedWindowCounter({ limit: 20, windowMs: 60_000 });
/** Conta una lettura di pagina web: false oltre 20 al minuto per utente. */
export function consumeWebRead(userId: number): boolean {
  return webReadCounter.consume(`user:${userId}`).ok;
}

// Ricerche di best practice di Lucius (Gemini con ricerca Google): 10 al minuto per utente.
const bestPracticeCounter = fixedWindowCounter({ limit: 10, windowMs: 60_000 });
/** Conta una ricerca di best practice: false oltre 10 al minuto per utente. */
export function consumeBestPracticeSearch(userId: number): boolean {
  return bestPracticeCounter.consume(`user:${userId}`).ok;
}

/** Azzera il contatore delle ricerche di best practice (solo per i test). */
export function resetBestPracticeSearchLimit(): void {
  bestPracticeCounter.reset();
}

/** Azzera il contatore delle letture web (solo per i test). */
export function resetWebReadLimit(): void {
  webReadCounter.reset();
}

// Segnalazioni dei bug dal plugin (route pubbliche /api/embed/bugs): 60 richieste al minuto e 10 segnalazioni all'ora
// per IP, 20 messaggi all'ora per segnalazione. Contatori in memoria.
const bugIpRequestCounter = fixedWindowCounter({ limit: 60, windowMs: 60_000 });
const bugIpReportCounter = fixedWindowCounter({ limit: 10, windowMs: 3_600_000 });
const bugMessageCounter = fixedWindowCounter({ limit: 20, windowMs: 3_600_000 });

/** Conta una richiesta alle route delle segnalazioni da un IP: false oltre 60 al minuto. */
export function consumeBugIpRequest(ip: string): boolean {
  return bugIpRequestCounter.consume(`ip:${ip}`).ok;
}

/** Conta una nuova segnalazione da un IP: false oltre 10 all'ora. */
export function consumeBugIpReport(ip: string): boolean {
  return bugIpReportCounter.consume(`ip:${ip}`).ok;
}

/** Conta un messaggio del segnalante su una segnalazione: false oltre 20 all'ora. */
export function consumeBugMessage(reportId: number): boolean {
  return bugMessageCounter.consume(`report:${reportId}`).ok;
}

/** Azzera i contatori delle segnalazioni dei bug (solo per i test). */
export function resetBugLimits(): void {
  bugIpRequestCounter.reset();
  bugIpReportCounter.reset();
  bugMessageCounter.reset();
}

// Runner di collaudo: scambio del codice monouso, 10 al minuto per IP (route pubblica)
export const collaudoClaimRateLimit = rateLimit({ limit: 10, windowMs: 60_000 });
