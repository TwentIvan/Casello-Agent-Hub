// Elenco degli strumenti del server MCP dell'app come sorgente dell'analisi, come l'OpenAPI: letto
// una volta all'avvio (o al claim dell'analisi locale), tenuto in memoria e consultato dal modello a
// pagine (`list_mcp_tools`) e per nome (`read_mcp_tool`). Nomi, descrizioni e schemi sono dati del
// servizio, non attendibili: tornano al modello come testo e non finiscono nei log.

import { McpError, listMcpTools, type McpToolInfo } from "../tools/mcp-client";
import type { AppConnection } from "../tools/types";
import type { ReadLimits, ToolOutput } from "./phase-loop";
import { capOutput, fittingLines, logArg, sliceChars } from "./text";

const MAX_DESCRIPTION_CHARS = 150;
const MAX_DESCRIBE_CHARS = 12_000;

/**
 * Strumenti del server MCP dell'app; null se l'app non ha `mcpUrl` o il server non risponde (l'analisi
 * prosegue senza questa sorgente). Con `mcpUrl` scrive nel log dell'analisi il numero di strumenti o
 * «MCP: non raggiungibile» (mai il testo del servizio).
 */
export async function loadMcpSource(
  conn: AppConnection,
  log: (message: string) => void = () => {},
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<McpToolInfo[] | null> {
  if (!conn.mcpUrl) return null;
  try {
    const tools = await listMcpTools(conn, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
    log(`MCP: ${tools.length} strumenti`);
    return tools;
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    log("MCP: non raggiungibile");
    return null;
  }
}

/** Livello come lo vede il modello: dichiarato dal servizio o ripiego (livello non dichiarato). */
function levelLabel(tool: McpToolInfo): string {
  return tool.levelDeclared ? `livello ${tool.level}` : `livello ${tool.level} (non dichiarato: ripiego)`;
}

/**
 * Strumenti MCP a pagine, come `listOperations`: ordinati per nome, filtro per prefisso del nome, poi
 * `offset` strumenti saltati, poi quanti ne entrano nel tetto dell'output; se ne restano, l'ultima
 * riga dice come continuare. Ogni riga: nome — livello (dichiarato o ripiego) — descrizione.
 */
export function listMcpToolsPage(
  tools: McpToolInfo[],
  args: { prefix?: string | undefined; offset?: number | undefined },
  limits: ReadLimits,
): ToolOutput {
  const { prefix } = args;
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const filtered = prefix ? sorted.filter((t) => t.name.startsWith(prefix)) : sorted;
  const from = Math.max(Math.trunc(args.offset ?? 0), 0);
  const all = filtered.slice(from).map((t) =>
    [t.name, levelLabel(t), t.description ? sliceChars(t.description.replace(/\s+/g, " "), MAX_DESCRIPTION_CHARS) : null]
      .filter(Boolean)
      .join(" — "),
  );
  const lines = all.slice(0, fittingLines(all, limits));
  const shown = lines.length;
  const rest = all.length - shown;
  const where = prefix ? ` con prefisso ${logArg(prefix)}` : "";
  if (filtered.length === 0) lines.push(`Nessuno strumento${where} sul server MCP.`);
  else if (shown === 0) lines.push(`Nessuno strumento${where} oltre offset=${from} (sono ${filtered.length}).`);
  else if (from > 0 || rest > 0) lines.unshift(`Strumenti${where} ${from + 1}-${from + shown} di ${filtered.length}:`);
  if (rest > 0) lines.push(`[altri ${rest} strumenti: usa offset=${from + shown} o un prefix]`);
  return {
    content: capOutput(lines.join("\n"), limits),
    log: `list_mcp_tools${prefix ? ` ${logArg(prefix)}` : ""}${from ? ` offset=${from}` : ""} (${filtered.length} ${filtered.length === 1 ? "strumento" : "strumenti"})`,
  };
}

/** Uno strumento MCP per nome: livello (dichiarato o ripiego), descrizione e schema JSON dei parametri. */
export function describeMcpTool(tools: McpToolInfo[], name: string): string {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `strumento "${name}" non trovato sul server MCP`;
  const lines = [
    tool.name,
    levelLabel(tool),
    `descrizione: ${tool.description ?? "(nessuna)"}`,
    `schema dei parametri: ${JSON.stringify(tool.inputSchema)}`,
  ];
  const text = lines.join("\n");
  return text.length <= MAX_DESCRIBE_CHARS ? text : `${sliceChars(text, MAX_DESCRIBE_CHARS - 1)}…`;
}
