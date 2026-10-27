#!/usr/bin/env node
// Finto `claude` per i test del runner: accetta gli stessi argomenti di `claude -p`, legge il prompt dallo stdin e
// la configurazione MCP da `--mcp-config`, si collega al server MCP di Casello con il client dell'SDK, chiama
// `get_job` e lo strumento di consegna e stampa un esito JSON come `claude -p --output-format json`.
//
// Variabili (le passa il test attraverso l'ambiente del runner):
// - FAKE_CLAUDE_RECORD: file in cui aggiungere, una riga JSON per avvio, argomenti, cartella, configurazione MCP,
//   permessi del file e presenza del token di macchina nell'ambiente;
// - FAKE_CLAUDE_MODE: "mcp" (default), "record" (solo registrazione ed esito), "hang" (resta appeso e ignora
//   SIGTERM: per la prova di SIGKILL), "fail" (esce con codice 1 e un esito d'errore);
// - FAKE_CLAUDE_PLAN: file JSON `{ "results": { <fase>: <esito> } }` con gli esiti delle fasi dell'architetto.
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PHASES = ["map", "capabilities", "catalog", "agents", "completion", "evolution"];

const args = process.argv.slice(2);
const optionValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "mcp";
const prompt = await readStdin();
const configPath = optionValue("--mcp-config");
const configText = configPath ? readFileSync(configPath, "utf8") : "";
const config = configText ? JSON.parse(configText) : null;

if (process.env.FAKE_CLAUDE_RECORD) {
  appendFileSync(
    process.env.FAKE_CLAUDE_RECORD,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      cwdFiles: readdirSync(process.cwd()),
      configPath,
      config,
      configMode: configPath ? statSync(configPath).mode & 0o777 : null,
      machineTokenInEnv: process.env.CASELLO_RUNNER_TOKEN !== undefined,
      promptLength: prompt.length,
      pid: process.pid,
    }) + "\n",
  );
}

const sessionId = optionValue("--resume") ?? `fake-${randomUUID()}`;
const print = (isError) =>
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      result: isError ? "errore" : "fatto",
      session_id: sessionId,
      usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 5 },
    }),
  );

if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  print(true);
  process.exitCode = 1;
} else if (mode === "record") {
  print(false);
} else {
  const server = config.mcpServers.casello;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  const client = new Client({ name: "finto-claude", version: "0" });
  await client.connect(transport);
  await client.callTool({ name: "get_job", arguments: {} });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  if (names.includes("finish_run")) {
    await client.callTool({ name: "finish_run", arguments: { content: "fatto dal finto Claude" } });
  } else if (names.includes("submit_phase_result")) {
    const plan = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_PLAN, "utf8"));
    const phase = PHASES[Number(/FASE (\d)/.exec(prompt)?.[1] ?? 1) - 1];
    await client.callTool({ name: "submit_phase_result", arguments: { result: plan.results[phase] } });
  }
  await client.close();
  print(false);
}
