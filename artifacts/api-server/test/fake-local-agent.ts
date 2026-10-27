import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { db, localMachinesTable, type LocalJob } from "@workspace/db";
import { jobByToken, nextForMachine, reportItemDone, type RunnerDelivery } from "../src/lib/local/jobs";
import { createMcpServer } from "../src/lib/local/mcp-server";

// Finto agente locale per i test: un runner (stesse funzioni delle route /runner) che a ogni compito fa agire un
// "Claude" a copione attraverso il server MCP di Casello, collegato in memoria con il client dell'SDK.

/** Client MCP collegato in memoria al server di Casello per un lavoro (come il runner con il token del lavoro). */
export async function mcpClientFor(job: LocalJob): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ kind: "job", job });
  await server.connect(serverSide);
  const client = new Client({ name: "finto-claude", version: "0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Testo e flag d'errore di un risultato di strumento. */
export function toolText(result: Awaited<ReturnType<Client["callTool"]>>): { text: string; isError: boolean } {
  const content = result.content as Array<{ type: string; text?: string }>;
  return { text: content[0]?.text ?? "", isError: result.isError === true };
}

/** Chiamata a uno strumento MCP, come testo e flag d'errore. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  return toolText(await client.callTool({ name, arguments: args }));
}

/** Attende il primo segnale di vita del runner della macchina (da lì la macchina risulta collegata). */
export async function waitConnected(machineId: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [m] = await db.select({ lastSeenAt: localMachinesTable.lastSeenAt }).from(localMachinesTable).where(eq(localMachinesTable.id, machineId));
    if (m?.lastSeenAt) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("runner non collegato");
}

/** Comportamento del finto Claude su un compito: cosa riporta il runner al done. */
export type FakeClaude = (
  delivery: RunnerDelivery,
  client: Client,
) => Promise<{ sessionId?: string; exit?: "done" | "error"; usage?: { inputTokens: number; outputTokens: number } | null }>;

export interface FakeRunner {
  deliveries: RunnerDelivery[];
  errors: unknown[];
  stop: () => void;
}

/** Runner finto della macchina: prende i lavori, esegue i compiti col finto Claude e riporta il done. */
export function startFakeRunner(machineId: number, claude: FakeClaude): FakeRunner {
  const ac = new AbortController();
  const runner: FakeRunner = { deliveries: [], errors: [], stop: () => ac.abort() };
  void (async () => {
    while (!ac.signal.aborted) {
      try {
        const d = await nextForMachine(machineId, ac.signal);
        if (!d) continue;
        runner.deliveries.push(d);
        const job = await jobByToken(d.jobToken);
        if (!job) throw new Error("token del lavoro non valido");
        const { client, close } = await mcpClientFor(job);
        let out: Awaited<ReturnType<FakeClaude>>;
        try {
          out = await claude(d, client);
        } finally {
          await close();
        }
        await reportItemDone(machineId, d.itemId, {
          sessionId: out.sessionId ?? `sess-${runner.deliveries.length}`,
          exit: out.exit ?? "done",
          usage: out.usage ?? null,
        });
      } catch (err) {
        runner.errors.push(err);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  })();
  return runner;
}
