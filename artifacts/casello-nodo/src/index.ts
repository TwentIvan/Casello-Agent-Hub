// Entrata di `casello-nodo`: comandi install, uninstall, status, run (vedi cli.ts).
import { fileURLToPath } from "node:url";
import { realDeps, runCli } from "./cli";

void runCli(process.argv.slice(2), realDeps(fileURLToPath(import.meta.url))).then((code) => process.exit(code));
