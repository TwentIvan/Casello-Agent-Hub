// Aggiornamenti in tempo reale delle run (issue #108): flusso Server-Sent Events `GET /api/live` e stato per agente
// `GET /api/agent-activity`. Il flusso dice solo QUALE run è cambiata (id della run e dell'agente): la console
// ricarica con le route di sempre, così permessi e forma dei dati restano quelli delle GET.
import { Router, type IRouter, type Request, type Response } from "express";
import { ListAgentActivityResponse } from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { listAgentActivity } from "../lib/live/activity";
import { createRunChangeBatcher, subscribeRunChanges } from "../lib/live/events";

/** Avvisi raccolti in un solo messaggio per finestra. */
export const LIVE_BATCH_MS = 300;
/** Commento periodico: tiene aperta la connessione oltre i timeout dei proxy (nginx 60 s). */
export const LIVE_HEARTBEAT_MS = 25_000;
/** Flussi aperti al più per utente (schede della console): oltre → 429. */
export const LIVE_MAX_STREAMS_PER_USER = 6;
/** Attesa suggerita al browser prima di riconnettersi. */
const RETRY_MS = 5_000;

export const LIVE_MESSAGES = {
  tooManyStreams: "troppi aggiornamenti in tempo reale aperti: chiudi qualche scheda",
} as const;

const openStreams = new Map<number, number>();

/** Flussi aperti di un utente (per i test). */
export function liveStreamCount(userId: number): number {
  return openStreams.get(userId) ?? 0;
}

function handleLive(req: Request, res: Response): void {
  const userId = currentUserId(req);
  const open = openStreams.get(userId) ?? 0;
  if (open >= LIVE_MAX_STREAMS_PER_USER) {
    res.status(429).json({ error: LIVE_MESSAGES.tooManyStreams });
    return;
  }
  openStreams.set(userId, open + 1);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx non deve trattenere il flusso nel suo buffer
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`retry: ${RETRY_MS}\n`);
  res.write(`event: ready\ndata: {}\n\n`);

  const batcher = createRunChangeBatcher((changes) => {
    res.write(`event: runs\ndata: ${JSON.stringify({ runs: changes })}\n\n`);
  }, LIVE_BATCH_MS);
  const unsubscribe = subscribeRunChanges((change) => batcher.push(change));
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), LIVE_HEARTBEAT_MS);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    batcher.stop();
    const left = (openStreams.get(userId) ?? 1) - 1;
    if (left > 0) openStreams.set(userId, left);
    else openStreams.delete(userId);
  };
  req.on("close", close);
  res.on("close", close);
  res.on("error", close);
}

export function createLiveRouter(): IRouter {
  const router: IRouter = Router();

  // Solo con il login: EventSource non manda l'header Authorization, e il pannello incorporato resta sul polling.
  router.get("/live", sessionOnly, handleLive);

  router.get("/agent-activity", async (req, res) => {
    const activity = await listAgentActivity(currentUserId(req));
    res.json(ListAgentActivityResponse.parse(activity));
  });

  return router;
}
