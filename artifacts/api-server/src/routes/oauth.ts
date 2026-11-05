import { Router, type IRouter } from "express";
import { authorizationServerMetadata, protectedResourceMetadata } from "../lib/oauth/metadata";
import { registerClient } from "../lib/oauth/clients";
import { OAuthError } from "../lib/oauth/errors";
import { oauthRegisterRateLimit } from "../middlewares/rate-limit";

/** Route OAuth del connettore, alla radice dell'app (fuori da /api). */
export function oauthRouter(): IRouter {
  const r = Router();

  r.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json(protectedResourceMetadata());
  });
  r.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationServerMetadata());
  });

  r.post("/oauth/register", oauthRegisterRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const out = await registerClient(req.body);
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof OAuthError) {
        res.status(err.status).json(err.toJSON());
        return;
      }
      throw err;
    }
  });

  return r;
}
