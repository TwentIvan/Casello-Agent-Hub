import { Router, type IRouter } from "express";
import { ListOAuthGrantsResponse, RevokeOAuthGrantParams } from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { OAUTH_GRANT_MESSAGES, listGrants, revokeGrant } from "../lib/oauth/grants";
import { parseRequest } from "../middlewares/error-handler";

// App collegate (connettore OAuth) dell'utente: si gestiscono solo con il login.

export function createOAuthGrantsRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/oauth-grants", sessionOnly, async (req, res) => {
    res.json(ListOAuthGrantsResponse.parse(await listGrants(currentUserId(req))));
  });

  router.delete("/account/oauth-grants/:id", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RevokeOAuthGrantParams, req.params);
    if (!(await revokeGrant(currentUserId(req), id))) {
      res.status(404).json({ error: OAUTH_GRANT_MESSAGES.notFound });
      return;
    }
    res.status(204).end();
  });

  return router;
}

export default createOAuthGrantsRouter;
