import type { Request, RequestHandler } from "express";

// Rate limit minimo in memoria, a finestra fissa per chiave (di default l'IP). Basta un solo
// container API: con più repliche ognuna avrebbe il suo contatore.
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
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const now = Date.now();

    // Pulizia delle finestre scadute, così la mappa non cresce senza limite.
    if (hits.size > 1000) {
      for (const [key, entry] of hits) {
        if (entry.resetAt <= now) hits.delete(key);
      }
    }

    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;

    if (entry.count > limit) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
      return;
    }
    next();
  };
}

// Ogni run (avvio o ripresa) consuma token sul gateway: massimo 10 al minuto per IP,
// con un solo contatore condiviso da POST /agents/:id/runs e POST /runs/:id/resume.
export const runRateLimit = rateLimit({ limit: 10, windowMs: 60_000 });

// L'annullamento di una run non consuma token: ha un contatore proprio, più largo, così non
// compete con avvio e ripresa.
export const cancelRateLimit = rateLimit({ limit: 30, windowMs: 60_000 });
