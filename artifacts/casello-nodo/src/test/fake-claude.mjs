#!/usr/bin/env node
// `claude` finto per i test: il primo argomento è la modalità, poi gli argomenti veri della CLI.
import { writeFileSync, existsSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
const sessionId = args[args.indexOf("--session-id") + 1];

function cliJson(result, extra = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: sessionId,
    total_cost_usd: 0.25,
    usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 40 },
    ...extra,
  });
}

function writeEsito() {
  if (!existsSync("casello-compito.md")) {
    process.stdout.write(cliJson("compito mancante", { is_error: true }));
    process.exit(1);
  }
  writeFileSync(
    "casello-esito.json",
    JSON.stringify({ status: "done", outcome: "fatto dal file", detail: "dettaglio dal file" }),
  );
  process.stdout.write(cliJson("risultato della CLI"));
}

switch (mode) {
  case "esito":
    writeEsito();
    break;
  case "cli":
    process.stdout.write(cliJson("risultato della CLI ".repeat(30)));
    break;
  case "slow":
    setTimeout(writeEsito, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "600"));
    break;
  case "sleep":
    setInterval(() => {}, 1000);
    break;
  case "stubborn":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    break;
  default:
    process.exit(2);
}
