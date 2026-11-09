#!/usr/bin/env node
// `claude` finto per la prova di flusso dei turni delegati (node-turn-flow.test.ts): legge il prompt da stdin e il
// file di `--mcp-config`, si collega davvero a /mcp/turn con il client MCP dell'SDK (Streamable HTTP), chiama
// `tools/list` e poi lo strumento indicato in FAKE_CLAUDE_PLAN, infine stampa un risultato JSON come `claude -p
// --output-format json`. Sta in api-server/test perché qui si risolve @modelcontextprotocol/sdk.
//
// FAKE_CLAUDE_PLAN: {"tool": "<nome>", "arguments": {…}, "result": "<testo finale>"}
// FAKE_CLAUDE_RECORD (facoltativo): file in cui scrivere ciò che il finto ha visto, per le verifiche del test.

import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const plan = JSON.parse(process.env.FAKE_CLAUDE_PLAN ?? "{}");
const stdin = await readStdin();
const mcp = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.botcave;

const client = new Client({ name: "fake-claude", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }));
const { tools } = await client.listTools();
const call = await client.callTool({ name: plan.tool, arguments: plan.arguments ?? {} });
await client.close();

if (process.env.FAKE_CLAUDE_RECORD) {
  writeFileSync(
    process.env.FAKE_CLAUDE_RECORD,
    JSON.stringify({
      args: process.argv.slice(2),
      stdin,
      mcpType: mcp.type,
      mcpUrl: mcp.url,
      bearerIsTurnToken: /^Bearer cat_/.test(mcp.headers.Authorization ?? ""),
      tools: tools.map((t) => t.name),
      callIsError: call.isError === true,
      callText: call.content?.[0]?.text ?? null,
    }),
  );
}

process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: plan.result ?? "Fatto.",
    total_cost_usd: 0.001,
    session_id: "s",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }),
);
