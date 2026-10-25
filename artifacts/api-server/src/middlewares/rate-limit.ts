import type { RequestHandler } from "express";

// Rate limit minimo in memoria, a finestra fissa per IP. Basta un solo container API:
// con più repliche ognuna avrebbe il suo contatore.
export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const now = Date.now();

    // Pulizia delle finestre scadute, così la mappa non cresce senza limite.
    if (hits.size > 1000) {
      for (const [key, entry] of hits) {
        if (entry.resetAt <= now) hits.delete(key);
      }
    }

    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
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
