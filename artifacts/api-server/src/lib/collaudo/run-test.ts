import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  appArchitectureTable,
  appsTable,
  db,
  releaseTestStepsTable,
  releaseTestsTable,
  teamCodeTasksTable,
  teamInstancesTable,
} from "@workspace/db";
import { runAgentLoop, type LoopDeps, type LoopLimits } from "../agent-loop";
import { logger } from "../logger";
import { modelChatDeps, newUsage, stepWriter, usageCost, type LoopUsage } from "../loop-wiring";
import { redactCredentials } from "../memory/credentials";
import { getPlan } from "../teams/plan";
import { internalTool, roleFunctionTools, toolSchemaLookup } from "../teams/role-tools";
import type { CatalogTool, ToolResult } from "../tools/types";
import { enqueueCommand, expireOpenCommands, waitCommandResult } from "./commands";
import { COLLAUDO_MESSAGES } from "./messages";
import { testModelFor } from "./model";
import { toDbOutcome, type DeliveredOutcome } from "./outcome";
import { COLLAUDO_INSTRUCTIONS, MAX_START_ROUNDS, START_EXHAUSTED_NOTE, contextMessages, dataBlock, type WorkTaskInfo } from "./prompts";
import { validateRecipe, type TestRecipe } from "./recipe";
import { saveTestRecipe } from "./recipe-store";

// Collaudatore: agente che gira in Botcave con il ciclo di sempre e il modello del capo, e comanda da remoto il runner del
// collaudo con `shell` e `browser` (ogni chiamata è un comando in coda, il risultato torna come risultato dello strumento).
// Non cambia lo stato del collaudo (resta `running` fino al report del runner): scrive esito, resoconto, problemi, note non
// provabili oppure l'errore, e token e costo.

export const COLLAUDO_LIMITS: LoopLimits = { maxRounds: 40, maxActiveMs: 2_400_000, maxTokens: 300_000 };
export { MAX_START_ROUNDS } from "./prompts";

/** Attesa massima del risultato di un comando del runner. */
export const COMMAND_WAIT_MS = 6 * 60_000;
/** Timeout massimo di un comando `shell`. */
export const MAX_SHELL_TIMEOUT_SEC = 300;
/** Risposta di una chiamata al modello: la consegna porta un resoconto fino a 8 000 caratteri. */
const COMPLETION_TOKENS = 6000;

const MAX_REPORT = 8_000;
const MAX_PROBLEMS = 20;
const MAX_NOT_TESTABLE = 20;

const BROWSER_ACTIONS = ["open", "click", "fill", "press", "snapshot", "screenshot", "wait"] as const;

const ShellArgs = z
  .object({
    command: z.string().trim().min(1).max(4_000),
    cwd: z.string().trim().min(1).max(300).nullish(),
    timeoutSec: z.number().int().min(1).nullish(),
    background: z.boolean().nullish(),
  })
  .strict();

const BrowserArgs = z
  .object({
    action: z.enum(BROWSER_ACTIONS),
    url: z.string().min(1).max(2_000).nullish(),
    selector: z.string().min(1).max(500).nullish(),
    text: z.string().max(2_000).nullish(),
  })
  .strict();

const ProblemSchema = z.object({
  compito: z.string().trim().min(1).max(40).optional(),
  titolo: z.string().trim().min(1).max(200),
  passi: z.string().trim().min(1).max(4_000),
  atteso: z.string().trim().min(1).max(2_000),
  ottenuto: z.string().trim().min(1).max(2_000),
  screenshot: z.string().trim().min(1).max(200).optional(),
});

const DeliverySchema = z.object({
  esito: z.enum(["ok", "problemi", "non_avviabile"]),
  resoconto: z.string().trim().min(1).max(MAX_REPORT),
  problemi: z.array(ProblemSchema).max(MAX_PROBLEMS).default([]),
  nonProvabile: z.array(z.string().trim().min(1).max(500)).max(MAX_NOT_TESTABLE).default([]),
});

/** Problema come si salva in `release_tests.problems` (testi ripuliti dalle credenziali). */
export interface TestProblem {
  task: string | null;
  title: string;
  steps: string;
  expected: string;
  actual: string;
  screenshot: string | null;
}

interface Delivery {
  outcome: DeliveredOutcome;
  report: string;
  problems: TestProblem[];
  notTestable: string[];
}

export const SHELL_TOOL = internalTool("shell", "Esegue un comando sul runner del collaudo e ne restituisce l'uscita (al più 8 000 caratteri).", {
  type: "object",
  properties: {
    command: { type: "string", description: "Comando da eseguire (bash)" },
    cwd: { type: "string", description: "Cartella relativa al repository (facoltativa)" },
    timeoutSec: { type: "integer", minimum: 1, maximum: MAX_SHELL_TIMEOUT_SEC, description: "Tempo massimo in secondi (default del runner)" },
    background: { type: "boolean", description: "Vero per i servizi che restano accesi" },
  },
  required: ["command"],
});

export const BROWSER_TOOL = internalTool("browser", "Comanda il browser del runner sull'App avviata.", {
  type: "object",
  properties: {
    action: { type: "string", enum: [...BROWSER_ACTIONS] },
    url: { type: "string", description: "Per open: indirizzo (anche relativo all'App)" },
    selector: { type: "string", description: "Per click, fill e wait: selettore dell'elemento" },
    text: { type: "string", description: "Per fill: testo; per press: tasto; per wait: testo atteso" },
  },
  required: ["action"],
});

export const SAVE_RECIPE_TOOL = internalTool("salva_ricetta", "Salva la ricetta di avvio dell'App (solo quando l'App risponde).", {
  type: "object",
  properties: {
    ricetta: {
      type: "object",
      description:
        "{install: [comandi], build: [comandi], services: [{name, command, port, readyPath}], postgres: boolean, schema: [comandi], env: {NOME: valore}, startUrl: '/percorso', login: testo o null}",
    },
  },
  required: ["ricetta"],
});

export const DELIVER_TOOL = internalTool("consegna_collaudo", "Chiude il collaudo con l'esito. Una sola volta, alla fine.", {
  type: "object",
  properties: {
    esito: { type: "string", enum: ["ok", "problemi", "non_avviabile"] },
    resoconto: { type: "string", maxLength: MAX_REPORT, description: "Resoconto in Markdown di cosa hai provato" },
    problemi: {
      type: "array",
      maxItems: MAX_PROBLEMS,
      items: {
        type: "object",
        properties: {
          compito: { type: "string", description: "Id del compito del lavoro (facoltativo)" },
          titolo: { type: "string" },
          passi: { type: "string", description: "Passi per riprodurlo" },
          atteso: { type: "string" },
          ottenuto: { type: "string" },
          screenshot: { type: "string", description: "Nome dello screenshot (facoltativo)" },
        },
        required: ["titolo", "passi", "atteso", "ottenuto"],
      },
    },
    nonProvabile: { type: "array", maxItems: MAX_NOT_TESTABLE, items: { type: "string" }, description: "Cosa non si è potuto provare (servizi esterni spenti…)" },
  },
  required: ["esito", "resoconto"],
});

const TOOLS: CatalogTool[] = [SHELL_TOOL, BROWSER_TOOL, SAVE_RECIPE_TOOL, DELIVER_TOOL];

const MESSAGES = {
  invalidShell: `argomenti non validi: serve command (testo), timeoutSec fino a ${MAX_SHELL_TIMEOUT_SEC}`,
  shellTimeout: `timeoutSec al massimo ${MAX_SHELL_TIMEOUT_SEC}`,
  invalidBrowser: `argomenti non validi: action tra ${BROWSER_ACTIONS.join(", ")}, url, selector e text testi`,
  recipeSaved: (version: number) => `ricetta salvata (versione ${version})`,
  recipeFailed: "ricetta non salvata: riprova",
  invalidDelivery:
    "consegna non valida: servono esito (ok, problemi, non_avviabile), resoconto (al più 8 000 caratteri), problemi (al più 20, con titolo, passi, atteso, ottenuto) e nonProvabile (al più 20)",
  delivered: "collaudo consegnato",
  alreadyDelivered: "collaudo già consegnato",
  unknown: "strumento non disponibile",
} as const;

/** Argomenti senza i campi null o assenti (molti provider mandano `"cwd": null`). */
function withoutNulls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Risultato di un comando del runner come dato non attendibile. */
function commandResult(kind: string, r: { ok: boolean; output: string }, note: string | null): ToolResult {
  const body = dataBlock(r.ok ? `Uscita di ${kind}` : `Uscita di ${kind} (non riuscito)`, r.output || "(vuota)");
  return { ok: r.ok, content: note ? `${body}\n\n${note}` : body };
}

/** Copia degli argomenti con le parole che sembrano credenziali sostituite da `***` (per i passi). */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

function toDelivery(data: z.infer<typeof DeliverySchema>): Delivery {
  const clean = (text: string) => redactCredentials(text);
  return {
    outcome: data.esito,
    report: clean(data.resoconto),
    problems: data.problemi.map((p) => ({
      task: p.compito ?? null,
      title: clean(p.titolo),
      steps: clean(p.passi),
      expected: clean(p.atteso),
      actual: clean(p.ottenuto),
      screenshot: p.screenshot ? clean(p.screenshot) : null,
    })),
    notTestable: data.nonProvabile.map(clean),
  };
}

/** Salva la ricetta come versione nuova dell'App (sorgente `agent`); restituisce la versione. */
async function saveRecipe(appId: number, recipe: TestRecipe): Promise<number> {
  const version = await saveTestRecipe(appId, recipe, "agent");
  if (version === null) throw new Error("app not found");
  return version;
}

/** Compiti con codice del lavoro, con titolo, issue ed esito dal PLAN. */
async function workTasks(instanceId: number, workId: number): Promise<WorkTaskInfo[]> {
  const rows = await db
    .select({ planTaskId: teamCodeTasksTable.planTaskId, prNumber: teamCodeTasksTable.prNumber })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.instanceId, instanceId), eq(teamCodeTasksTable.workId, workId)))
    .orderBy(asc(teamCodeTasksTable.id));
  if (rows.length === 0) return [];
  const plan = await getPlan(instanceId);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  return rows.map((r) => {
    const t = byId.get(r.planTaskId);
    return { id: r.planTaskId, title: t?.title ?? r.planTaskId, issue: t?.issue ?? null, outcome: t?.outcome ?? null, prNumber: r.prNumber };
  });
}

/** Token e costo del collaudo (la colonna del costo è null se parziale). */
function usageColumns(usage: LoopUsage) {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usageCost(usage),
  };
}

/**
 * Esegue l'agente collaudatore per il collaudo `testId` (già `running`). Mai eccezioni: un errore inatteso diventa
 * `error` sul collaudo. Il collaudo resta `running`: lo chiude il report del runner.
 */
export async function runReleaseTest(testId: number, signal?: AbortSignal): Promise<void> {
  const usage = newUsage();
  let aiModelId: number | null = null;
  try {
    const [test] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId)).limit(1);
    if (!test) return;
    const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, test.instanceId)).limit(1);
    const [app] = await db.select().from(appsTable).where(eq(appsTable.id, test.appId)).limit(1);
    if (!instance || !app) {
      await db.update(releaseTestsTable).set({ error: COLLAUDO_MESSAGES.internalError }).where(eq(releaseTestsTable.id, testId));
      return;
    }

    const model = await testModelFor(instance);
    if ("skip" in model) {
      await db.update(releaseTestsTable).set({ error: model.skip }).where(eq(releaseTestsTable.id, testId));
      logger.info({ releaseTestId: testId }, "Collaudo senza modello usabile");
      return;
    }
    aiModelId = model.aiModelId;
    await db.update(releaseTestsTable).set({ aiModelId }).where(eq(releaseTestsTable.id, testId));

    const saved = app.testRecipe == null ? null : validateRecipe(app.testRecipe);
    const recipe = saved?.ok ? saved.recipe : null;
    const [arch] = await db.select({ summary: appArchitectureTable.summary }).from(appArchitectureTable).where(eq(appArchitectureTable.appId, app.id)).limit(1);
    const tasks = await workTasks(instance.id, test.workId);

    const delivery = await runCollaudoLoop({
      testId,
      appId: app.id,
      aiModelId,
      resolved: model.resolved,
      usage,
      hasRecipe: recipe !== null,
      messages: [
        { role: "system", content: COLLAUDO_INSTRUCTIONS },
        ...contextMessages({
          appName: app.name,
          appSlug: app.slug,
          repo: app.sourceRepo,
          sha: test.sha,
          recipe,
          architecture: arch?.summary ?? null,
          tasks,
        }).map((content) => ({ role: "user" as const, content })),
      ],
      ...(signal ? { signal } : {}),
    });

    await expireOpenCommands(testId);
    if (delivery) {
      await db
        .update(releaseTestsTable)
        .set({
          outcome: toDbOutcome(delivery.outcome),
          report: delivery.report,
          problems: delivery.problems,
          notTestable: delivery.notTestable,
          error: null,
          ...usageColumns(usage),
        })
        .where(eq(releaseTestsTable.id, testId));
    } else if (signal?.aborted) {
      // Interrotto da fuori (tempo scaduto, collaudo chiuso): il motivo lo scrive chi ha annullato, qui solo l'uso
      await db.update(releaseTestsTable).set(usageColumns(usage)).where(eq(releaseTestsTable.id, testId));
    } else {
      await db.update(releaseTestsTable).set({ error: COLLAUDO_MESSAGES.notDelivered, ...usageColumns(usage) }).where(eq(releaseTestsTable.id, testId));
    }
    logger.info({ releaseTestId: testId, delivered: delivery !== null, outcome: delivery?.outcome ?? null }, "Collaudatore finito");
  } catch (err) {
    logger.error({ releaseTestId: testId, errName: errName(err) }, "Collaudatore non riuscito");
    try {
      await db
        .update(releaseTestsTable)
        .set({ error: COLLAUDO_MESSAGES.internalError, ...(aiModelId !== null ? usageColumns(usage) : {}) })
        .where(eq(releaseTestsTable.id, testId));
    } catch (writeErr) {
      logger.error({ releaseTestId: testId, errName: errName(writeErr) }, "Errore del collaudatore non registrato");
    }
  }
}

interface LoopInput {
  testId: number;
  appId: number;
  aiModelId: number;
  resolved: Parameters<typeof modelChatDeps>[0]["resolved"];
  usage: LoopUsage;
  hasRecipe: boolean;
  messages: ChatCompletionMessageParam[];
  signal?: AbortSignal;
}

/** Ciclo del collaudatore: la consegna si registra e il ciclo si ferma senza altri giri. */
async function runCollaudoLoop(input: LoopInput): Promise<Delivery | null> {
  const stop = new AbortController();
  const loopSignal = input.signal ? AbortSignal.any([stop.signal, input.signal]) : stop.signal;
  let delivery: Delivery | null = null;
  let rounds = 0;
  let startDone = input.hasRecipe;
  const startNote = () => (!startDone && rounds > MAX_START_ROUNDS ? START_EXHAUSTED_NOTE : null);

  const runCommand = async (kind: "shell" | "browser", args: Record<string, unknown>): Promise<ToolResult> => {
    const id = await enqueueCommand(input.testId, kind, args);
    const result = await waitCommandResult(id, COMMAND_WAIT_MS, loopSignal);
    return commandResult(kind, result, startNote());
  };

  const execute: LoopDeps["executeTool"] = async (tool, args) => {
    switch (tool.name) {
      case SHELL_TOOL.name: {
        if (typeof args.timeoutSec === "number" && args.timeoutSec > MAX_SHELL_TIMEOUT_SEC) return { ok: false, content: MESSAGES.shellTimeout };
        const parsed = ShellArgs.safeParse(args);
        if (!parsed.success) return { ok: false, content: MESSAGES.invalidShell };
        return runCommand("shell", withoutNulls(parsed.data));
      }
      case BROWSER_TOOL.name: {
        const parsed = BrowserArgs.safeParse(args);
        if (!parsed.success) return { ok: false, content: MESSAGES.invalidBrowser };
        return runCommand("browser", withoutNulls(parsed.data));
      }
      case SAVE_RECIPE_TOOL.name: {
        const checked = validateRecipe(args.ricetta);
        if (!checked.ok) return { ok: false, content: checked.error };
        try {
          const version = await saveRecipe(input.appId, checked.recipe);
          startDone = true;
          return { ok: true, content: MESSAGES.recipeSaved(version) };
        } catch (err) {
          logger.warn({ releaseTestId: input.testId, errName: errName(err) }, "Ricetta del collaudo non salvata");
          return { ok: false, content: MESSAGES.recipeFailed };
        }
      }
      case DELIVER_TOOL.name: {
        if (delivery) return { ok: false, content: MESSAGES.alreadyDelivered };
        const parsed = DeliverySchema.safeParse(args);
        if (!parsed.success) return { ok: false, content: MESSAGES.invalidDelivery };
        delivery = toDelivery(parsed.data);
        stop.abort();
        return { ok: true, content: MESSAGES.delivered };
      }
      default:
        return { ok: false, content: MESSAGES.unknown };
    }
  };

  const chat = modelChatDeps({
    aiModelId: input.aiModelId,
    functionTools: roleFunctionTools([], TOOLS),
    caller: "release-test",
    usage: input.usage,
    maxTokens: COMPLETION_TOKENS,
    signal: loopSignal,
    logContext: { releaseTestId: input.testId },
    ...(input.resolved ? { resolved: input.resolved } : {}),
  });

  const writeStep = stepWriter((row) => db.insert(releaseTestStepsTable).values({ testId: input.testId, ...row }), toolSchemaLookup(TOOLS));
  const deps: LoopDeps = {
    chat: async (messages, opts) => {
      rounds++;
      return chat(messages, opts);
    },
    tools: TOOLS,
    executeTool: execute,
    // Nessuno strumento del collaudatore va in coda: sono tutti interni
    queueAction: async () => ({ ok: false, message: MESSAGES.unknown }),
    // Comandi, ricetta e resoconto finiscono nei passi: senza credenziali
    onStep: (step) => writeStep(step.args === undefined ? step : { ...step, args: redactDeep(step.args) }),
    limits: COLLAUDO_LIMITS,
    signal: loopSignal,
  };
  await runAgentLoop({ messages: input.messages, queue: [], rounds: 0, tokens: 0, activeMs: 0 }, deps);
  return delivery;
}
