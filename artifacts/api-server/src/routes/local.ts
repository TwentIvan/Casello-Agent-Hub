import { Router, type IRouter } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, mcpTokensTable, type McpToken } from "@workspace/db";
import {
  ChooseLocalJobBody,
  ChooseLocalJobParams,
  CreateLocalMachineBody,
  CreateLocalMachineResponse,
  CreatePersonalTokenBody,
  CreatePersonalTokenResponse,
  ListLocalJobsResponse,
  ListLocalMachinesResponse,
  ListPersonalTokensResponse,
  RevokeLocalMachineParams,
  RevokePersonalTokenParams,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { chooseForJob, listOpenJobs, LocalJobError, toPublicJob } from "../lib/local/jobs";
import { listMachines, registerMachine, revokeMachine, toPublicMachine } from "../lib/local/machines";
import { newToken } from "../lib/local/tokens";
import { parseRequest } from "../middlewares/error-handler";

// Agente locale dalla console (sessione): macchine su cui gira il runner e token personali per la chat.
// I token si mostrano una sola volta alla creazione; nel DB c'è solo il loro hash. Ognuno vede e revoca
// solo i propri: quelli altrui rispondono 404 come se non esistessero.

const NAME_REQUIRED = "nome obbligatorio, senza caratteri di controllo";
const MACHINE_NOT_FOUND = "macchina non trovata";
const TOKEN_NOT_FOUND = "token non trovato";

// Caratteri di controllo C0, DEL e C1
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function cleanName(raw: string): string | null {
  const name = raw.trim();
  return name && !CONTROL_RE.test(name) ? name : null;
}

/** Forma pubblica di un token personale: mai l'hash. */
function toPublicToken(t: McpToken) {
  return { id: t.id, name: t.name, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt, createdAt: t.createdAt };
}

export function createLocalRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/local/machines", async (req, res) => {
    const now = new Date();
    const machines = await listMachines(currentUserId(req));
    res.json(ListLocalMachinesResponse.parse(machines.map((m) => toPublicMachine(m, now))));
  });

  router.post("/local/machines", async (req, res) => {
    const name = cleanName(parseRequest(CreateLocalMachineBody, req.body).name);
    if (!name) {
      res.status(400).json({ error: NAME_REQUIRED });
      return;
    }
    const { machine, token } = await registerMachine(currentUserId(req), name);
    res.status(201).json(CreateLocalMachineResponse.parse({ machine: toPublicMachine(machine), token }));
  });

  router.delete("/local/machines/:id", async (req, res) => {
    const { id } = parseRequest(RevokeLocalMachineParams, req.params);
    if (!(await revokeMachine(currentUserId(req), id))) {
      res.status(404).json({ error: MACHINE_NOT_FOUND });
      return;
    }
    res.status(204).end();
  });

  router.get("/local/tokens", async (req, res) => {
    const rows = await db
      .select()
      .from(mcpTokensTable)
      .where(eq(mcpTokensTable.userId, currentUserId(req)))
      .orderBy(asc(mcpTokensTable.createdAt), asc(mcpTokensTable.id));
    res.json(ListPersonalTokensResponse.parse(rows.map(toPublicToken)));
  });

  router.post("/local/tokens", async (req, res) => {
    const name = cleanName(parseRequest(CreatePersonalTokenBody, req.body).name);
    if (!name) {
      res.status(400).json({ error: NAME_REQUIRED });
      return;
    }
    const { token, hash } = newToken("personal");
    const [row] = await db.insert(mcpTokensTable).values({ userId: currentUserId(req), name, tokenHash: hash }).returning();
    res.status(201).json(CreatePersonalTokenResponse.parse({ personalToken: toPublicToken(row!), token }));
  });

  // Revoca idempotente: un token già revocato tiene la data della prima revoca
  router.delete("/local/tokens/:id", async (req, res) => {
    const { id } = parseRequest(RevokePersonalTokenParams, req.params);
    const userId = currentUserId(req);
    const where = and(eq(mcpTokensTable.id, id), eq(mcpTokensTable.userId, userId));
    const [row] = await db.select({ id: mcpTokensTable.id }).from(mcpTokensTable).where(where).limit(1);
    if (!row) {
      res.status(404).json({ error: TOKEN_NOT_FOUND });
      return;
    }
    await db.update(mcpTokensTable).set({ revokedAt: new Date() }).where(and(where, isNull(mcpTokensTable.revokedAt)));
    res.status(204).end();
  });

  // Lavori aperti dell'utente (es. in attesa della scelta con l'agente locale non collegato)
  router.get("/local/jobs", async (req, res) => {
    const rows = await listOpenJobs(currentUserId(req));
    res.json(ListLocalJobsResponse.parse(rows.map(toPublicJob)));
  });

  router.post("/local/jobs/:id/choice", async (req, res) => {
    const { id } = parseRequest(ChooseLocalJobParams, req.params);
    const { choice } = parseRequest(ChooseLocalJobBody, req.body);
    try {
      await chooseForJob(id, currentUserId(req), choice);
    } catch (err) {
      if (!(err instanceof LocalJobError)) throw err;
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(204).end();
  });

  return router;
}
