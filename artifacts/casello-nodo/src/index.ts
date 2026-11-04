// Avvio minimo del nodo in primo piano; i comandi (install, uninstall, status, run) arrivano con cli.ts.
import { ConfigError, defaultPaths, loadConfig, type Config } from "./config";
import { startLoop } from "./loop";

function main(): void {
  const paths = defaultPaths();
  let config: Config;
  try {
    config = loadConfig(paths.configPath);
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : "config non leggibile"}\n`);
    process.exit(1);
  }
  const loop = startLoop(config, { logsDir: paths.logsDir, statePath: paths.statePath });
  const shutdown = () => {
    void loop.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
