#!/usr/bin/env node
// `claude` finto per i test: il primo argomento è la modalità, poi gli argomenti veri della CLI.
import { spawn } from "node:child_process";
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

function turnJson(result, extra = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: "s",
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 40 },
    ...extra,
  });
}

async function readStdin() {
  let data = "";
  for await (const c of process.stdin) data += c;
  return data;
}

switch (mode) {
  case "turn": {
    // risponde ripetendo il prompt ricevuto su stdin
    const input = await readStdin();
    process.stdout.write(turnJson(`ciao (${input})`));
    break;
  }
  case "turn-error": {
    await readStdin();
    process.stdout.write(turnJson(process.env.FAKE_ERROR_TEXT ?? "boom", { is_error: true, subtype: "error_during_execution" }));
    process.exit(1);
    break;
  }
  case "turn-stderr": {
    await readStdin();
    process.stderr.write(process.env.FAKE_ERROR_TEXT ?? "boom");
    process.exit(1);
    break;
  }
  case "turn-maxturns": {
    await readStdin();
    process.stdout.write(turnJson(process.env.FAKE_RESULT ?? "", { subtype: "error_max_turns", is_error: true }));
    break;
  }
  case "turn-slow": {
    await readStdin();
    setTimeout(() => process.stdout.write(turnJson("lento")), Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "300"));
    break;
  }
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
  case "badesito":
    // esito non valido: si usa il JSON della CLI
    writeFileSync("casello-esito.json", "{ non è json");
    process.stdout.write(cliJson("risultato della CLI"));
    break;
  case "badesito-nocli":
    writeFileSync("casello-esito.json", JSON.stringify({ status: "forse", outcome: "" }));
    break;
  case "nocost":
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "fatto senza costi" }));
    break;
  case "grandchild": {
    // un nipote che ignora SIGTERM e tiene aperto lo stdout ereditato
    const nipote = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    writeFileSync("nipote.pid", String(nipote.pid));
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.exit(2);
}
