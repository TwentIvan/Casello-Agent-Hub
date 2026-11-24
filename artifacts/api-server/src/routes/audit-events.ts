import { Router, type IRouter } from "express";
import { ListAuditEventsQueryParams, ListAuditEventsResponse } from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { listAuditEvents } from "../lib/audit/record";
import { parseRequest } from "../middlewares/error-handler";

// Registro delle azioni dell'utente (issue #115): solo i propri eventi e solo con il login.

export function createAuditEventsRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/audit-events", sessionOnly, async (req, res) => {
    const { limit, before } = parseRequest(ListAuditEventsQueryParams, req.query);
    const page = await listAuditEvents(currentUserId(req), { limit, ...(before !== undefined ? { before } : {}) });
    res.json(ListAuditEventsResponse.parse(page));
  });

  return router;
}
