import { db, agentsTable, appsTable, toolsTable, runsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { aiGateway, type GatewayMessage } from "./ai-gateway";

// The context block below is stable for a given agent between config edits:
// same app info, same system prompt, same tool list. Anthropic caches the
// prefix up to the breakpoint (system + this block), so repeated runs of the
// same agent hit cache instead of re-billing the full prefix. Only applied
// with the LiteLLM proxy active (see useProxyCache guard in executeRun) —
// the direct Anthropic/OpenAI branches would either reject or silently drop
// cache_control, so the block is sent as plain text there instead.
async function assembleAgentContext(agentId: number): Promise<string> {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, agent.appId)).limit(1);
  const tools = await db.select().from(toolsTable).where(eq(toolsTable.agentId, agentId));

  const toolLines = tools.length
    ? tools.map((t) => `- ${t.name} [${t.httpMethod} ${t.endpoint}]: ${t.description || ""}`).join("\n")
    : "(nessuno strumento configurato)";

  return [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `🤖 CONTESTO AGENTE: ${agent.name}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `App: ${app?.name ?? "?"} (${app?.baseUrl ?? "?"})`,
    app?.description ? app.description : "",
    "",
    "Istruzioni agente:",
    agent.systemPrompt || "(nessuna istruzione specifica)",
    "",
    "Strumenti disponibili:",
    toolLines,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function executeRun(runId: number): Promise<void> {
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!run) throw new Error(`Run ${runId} not found`);

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, run.agentId)).limit(1);
  if (!agent) throw new Error(`Agent ${run.agentId} not found`);

  const startMs = Date.now();
  await db.update(runsTable).set({ status: "running" }).where(eq(runsTable.id, runId));

  try {
    const contextBlock = await assembleAgentContext(run.agentId);
    const taskInput = run.input || "";

    const useProxyCache = Boolean(process.env.AI_GATEWAY_BASE_URL);
    const messages: GatewayMessage[] = [
      {
        role: "system",
        content:
          "Sei l'esecutore di un agente configurato nell'hub Casello. Usa il contesto fornito per rispondere in modo pertinente al task richiesto. Rispondi in italiano.",
      },
      {
        role: "user",
        content: useProxyCache
          ? [
              { type: "text", text: contextBlock, cache_control: { type: "ephemeral" } },
              { type: "text", text: "\n\nTask:\n" + taskInput },
            ]
          : contextBlock + "\n\nTask:\n" + taskInput,
      },
    ];

    const result = await aiGateway.complete({
      modelKey: agent.model,
      messages,
      maxTokens: 2000,
      temperature: 0.3,
      agentId: agent.id,
      caller: "run-executor",
    });

    await db
      .update(runsTable)
      .set({
        status: "succeeded",
        output: result.content,
        durationMs: Date.now() - startMs,
        finishedAt: new Date(),
      })
      .where(eq(runsTable.id, runId));
  } catch (err: any) {
    await db
      .update(runsTable)
      .set({
        status: "failed",
        errorMessage: err?.message ?? String(err),
        durationMs: Date.now() - startMs,
        finishedAt: new Date(),
      })
      .where(eq(runsTable.id, runId));
  }
}
