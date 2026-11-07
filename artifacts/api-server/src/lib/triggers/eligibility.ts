import type { AppTool } from "@workspace/db";
import { effectiveLevel } from "../tools/levels";

// Un innesco gira senza utente né token utente: solo tool di lettura (L0) della stessa app, eseguibili
// dal server (`http` o `mcp`), attivi e con l'identità di servizio (spec §4.1).
export function toolUsableByTrigger(tool: AppTool, agentAppId: number): boolean {
  return (
    tool.appId === agentAppId &&
    tool.status === "active" &&
    (tool.kind === "http" || tool.kind === "mcp") &&
    effectiveLevel(tool) === "L0" &&
    tool.identity === "service"
  );
}
