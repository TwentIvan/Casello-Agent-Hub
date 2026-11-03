// Livelli d'azione dei tool: L0 lettura, L1 azione reversibile, L2 con conferma (coda), L3 vietata.
// Il livello effettivo è il più alto tra quello dichiarato e la deroga dell'utente (che può solo alzarlo).

export type ToolLevel = "L0" | "L1" | "L2" | "L3";
export const TOOL_LEVELS: readonly ToolLevel[] = ["L0", "L1", "L2", "L3"];

/** Chiave dei metadati MCP con cui il servizio dichiara il livello di uno strumento. */
export const MCP_LEVEL_META_KEY = "casello/level";

const rank = (level: ToolLevel): number => TOOL_LEVELS.indexOf(level);

function isToolLevel(value: unknown): value is ToolLevel {
  return typeof value === "string" && (TOOL_LEVELS as readonly string[]).includes(value);
}

export function effectiveLevel(tool: { level: ToolLevel; levelOverride: ToolLevel | null }): ToolLevel {
  return tool.levelOverride !== null && rank(tool.levelOverride) > rank(tool.level) ? tool.levelOverride : tool.level;
}

/** La deroga è ammessa se assente o non inferiore al livello dichiarato. */
export function isValidOverride(declared: ToolLevel, override: ToolLevel | null): boolean {
  return override === null || rank(override) >= rank(declared);
}

/** Livello del metadato `casello/level` di uno strumento MCP, null se manca o non è valido. */
function metaLevel(meta: unknown): ToolLevel | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const declared = (meta as Record<string, unknown>)[MCP_LEVEL_META_KEY];
  return isToolLevel(declared) ? declared : null;
}

/** Livello dichiarato da uno strumento MCP: metadato `casello/level`, poi `readOnlyHint` (L0), poi L2. */
export function declaredLevelFromMcp(tool: { _meta?: unknown; annotations?: { readOnlyHint?: boolean } }): ToolLevel {
  return metaLevel(tool._meta) ?? (tool.annotations?.readOnlyHint === true ? "L0" : "L2");
}

/** Lo strumento MCP dichiara esplicitamente il livello (metadato `casello/level` valido). */
export function hasMcpLevelMeta(tool: { _meta?: unknown }): boolean {
  return metaLevel(tool._meta) !== null;
}

