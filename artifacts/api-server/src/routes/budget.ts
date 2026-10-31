import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { GetBudgetResponse, UpdateBudgetBody, UpdateBudgetResponse } from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { budgetColumn, budgetSummary } from "../lib/budget";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

// Riepilogo del mese per la console: avviso all'80% e finestra per annullare le run oltre il tetto
router.get("/budget", async (req, res) => {
  res.json(GetBudgetResponse.parse(await budgetSummary(currentUserId(req))));
});

// Tetto mensile dell'utente corrente (spesa sui propri account AI)
router.put("/budget", sessionOnly, async (req, res) => {
  const { monthlyBudgetUsd } = parseRequest(UpdateBudgetBody, req.body);
  const userId = currentUserId(req);
  await db.update(usersTable).set({ monthlyBudgetUsd: budgetColumn(monthlyBudgetUsd) }).where(eq(usersTable.id, userId));
  res.json(UpdateBudgetResponse.parse(await budgetSummary(userId)));
});

export default router;
