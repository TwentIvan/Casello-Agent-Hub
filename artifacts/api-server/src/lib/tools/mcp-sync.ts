import { and, eq } from "drizzle-orm";
import { db, appsTable, appToolsTable } from "@workspace/db";
import type { McpToolInfo } from "./mcp-client";
import { isValidOverride } from "./levels";

// Sincronizza il catalogo di un'app (`app_tools`) con gli strumenti del suo server MCP.

export interface McpSyncResult {
  added: number;
  updated: number;
  disabled: number;
  unchanged: number;
  /** Nomi di strumenti MCP uguali a un tool non MCP del catalogo: lasciati intatti. */
  conflicts: string[];
}

/** Uguaglianza strutturale di valori JSON (l'ordine delle chiavi non conta, jsonb non lo conserva). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export async function syncMcpTools(appId: number, tools: McpToolInfo[]): Promise<McpSyncResult> {
  return db.transaction(async (tx) => {
    const [app] = await tx
      .select({ serviceSecretEnc: appsTable.serviceSecretEnc })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1);
    if (!app) throw new Error(`App ${appId} non trovata`);
    const identity = app.serviceSecretEnc ? "service" : "user";

    const existing = await tx.select().from(appToolsTable).where(eq(appToolsTable.appId, appId));
    const byName = new Map(existing.map((t) => [t.name, t]));
    const listed = new Set(tools.map((t) => t.name));
    const result: McpSyncResult = { added: 0, updated: 0, disabled: 0, unchanged: 0, conflicts: [] };

    for (const info of tools) {
      const current = byName.get(info.name);
      if (!current) {
        await tx.insert(appToolsTable).values({
          appId,
          name: info.name,
          description: info.description,
          kind: "mcp",
          identity,
          level: info.level,
          status: "draft",
          paramsSchema: info.inputSchema,
          definition: { mcpName: info.name },
        });
        result.added++;
        continue;
      }
      if (current.kind !== "mcp") {
        result.conflicts.push(info.name);
        continue;
      }
      if (
        current.description === info.description &&
        current.level === info.level &&
        sameJson(current.paramsSchema, info.inputSchema)
      ) {
        result.unchanged++;
        continue;
      }
      // Una deroga più bassa del nuovo livello dichiarato non vale più
      const keepOverride = isValidOverride(info.level, current.levelOverride);
      await tx
        .update(appToolsTable)
        .set({
          description: info.description,
          paramsSchema: info.inputSchema,
          level: info.level,
          levelOverride: keepOverride ? current.levelOverride : null,
          updatedAt: new Date(),
        })
        .where(eq(appToolsTable.id, current.id));
      result.updated++;
    }

    for (const current of existing) {
      if (current.kind !== "mcp" || listed.has(current.name) || current.status === "disabled") continue;
      await tx
        .update(appToolsTable)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(and(eq(appToolsTable.id, current.id), eq(appToolsTable.appId, appId)));
      result.disabled++;
    }

    return result;
  });
}
