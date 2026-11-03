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

/** Livello dichiarato da uno strumento MCP: metadato `casello/level`, poi `readOnlyHint` (L0), poi L2. */
export function declaredLevelFromMcp(tool: { _meta?: unknown; annotations?: { readOnlyHint?: boolean } }): ToolLevel {
  const meta = tool._meta;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    const declared = (meta as Record<string, unknown>)[MCP_LEVEL_META_KEY];
    if (isToolLevel(declared)) return declared;
  }
  return tool.annotations?.readOnlyHint === true ? "L0" : "L2";
}

/**
 * Livello di un tool HTTP proposto dall'architetto, che ragiona ancora con i due flag:
 * conferma → L2, sola lettura → L0, altrimenti L1.
 */
export function levelFromProposalFlags(flags: { readOnly: boolean; requiresConfirmation: boolean }): ToolLevel {
  if (flags.requiresConfirmation) return "L2";
  return flags.readOnly ? "L0" : "L1";
}
