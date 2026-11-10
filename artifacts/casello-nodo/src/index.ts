// Entrata di `casello-nodo`: con argomenti i comandi della CLI (install, uninstall, status, run, --version, vedi cli.ts);
// senza argomenti dentro `Botcave Nodo.app` la modalità app (abbinamento e menu, vedi app-mode.ts); altrimenti l'uso.
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { isAppExecPath, realAppDeps, runAppMode } from "./app-mode";
import { NODE_VERSION } from "./capabilities";
import { realDeps, runCli } from "./cli";
import { appBaseUrl } from "./config";

// Eseguibile unico (SEA, bundle CommonJS): `import.meta.url` non esiste e il programma è l'eseguibile stesso.
// Nella SEA `process.argv` è [eseguibile, eseguibile, …argomenti], come [node, script, …argomenti] della CLI.
const entryPath = isSea() ? process.execPath : fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const done =
  argv.length === 0 && isAppExecPath(process.execPath)
    ? runAppMode(realAppDeps({ caselloUrl: appBaseUrl(), version: NODE_VERSION, programSource: process.execPath }))
    : runCli(argv, realDeps(entryPath));
void done.then((code) => process.exit(code));
