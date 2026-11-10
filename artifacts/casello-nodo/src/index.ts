// Entrata di `casello-nodo`: con argomenti i comandi della CLI (install, uninstall, status, run, vedi cli.ts); senza
// argomenti dentro `Botcave Nodo.app` la modalità app (abbinamento e menu, vedi app-mode.ts); altrimenti l'uso.
import { fileURLToPath } from "node:url";
import { isAppExecPath, realAppDeps, runAppMode } from "./app-mode";
import { NODE_VERSION } from "./capabilities";
import { realDeps, runCli } from "./cli";
import { appBaseUrl } from "./config";

const argv = process.argv.slice(2);
const done =
  argv.length === 0 && isAppExecPath(process.execPath)
    ? runAppMode(realAppDeps({ caselloUrl: appBaseUrl(), version: NODE_VERSION, programSource: process.execPath }))
    : runCli(argv, realDeps(fileURLToPath(import.meta.url)));
void done.then((code) => process.exit(code));
