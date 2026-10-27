import { readConfig, runRunner } from "./runner";

// Avvio del runner: `CASELLO_URL=https://… CASELLO_RUNNER_TOKEN=csl_m_… pnpm --filter @workspace/casello-runner start`.
// SIGINT/SIGTERM: il compito in corso viene terminato e riportato a Casello con exit error, poi il runner esce;
// un secondo segnale esce subito.

let config: ReturnType<typeof readConfig>;
try {
  config = readConfig(process.env);
} catch (err) {
  console.error(`[casello-runner] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const stop = new AbortController();
const onSignal = (sig: NodeJS.Signals) => {
  if (stop.signal.aborted) process.exit(130);
  console.error(`[casello-runner] ${sig}: arresto in corso`);
  stop.abort();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  await runRunner({ ...config, signal: stop.signal });
} catch (err) {
  console.error(`[casello-runner] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
