import type { AppTool } from "@workspace/db";

export type ToolKind = "http" | "ui" | "composite" | "mcp";
export type ToolIdentity = "user" | "service";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpDefinition {
  method: HttpMethod;
  path: string;
  paramLocations: Record<string, "path" | "query" | "body">;
  responseFields?: string[];
}

export interface UiDefinition {
  action: string;
  args?: Record<string, unknown>;
}

export interface CompositeDefinition {
  steps: { tool: string; args: Record<string, string> }[];
  output: Record<string, string>;
}

export interface McpDefinition {
  mcpName: string;
}

export type ToolDefinition = HttpDefinition | UiDefinition | CompositeDefinition | McpDefinition;

// Riga di `app_tools` con schema dei parametri e definizione tipizzati
export type CatalogTool = Omit<AppTool, "paramsSchema" | "definition"> & {
  paramsSchema: Record<string, unknown>;
  definition: ToolDefinition;
  /**
   * Solo per i tool `composite`: i tool dei passi, nell'ordine della definizione, già risolti e verificati
   * (`resolveCompositeTools` in catalog.ts). Senza, l'esecutore non esegue il tool composto.
   */
  compositeSteps?: CatalogTool[];
};

export interface ToolResult {
  ok: boolean;
  status?: number;
  content: string;
  /** La durata è attesa (es. consultazione di un collega), non lavoro: non conta nel tempo attivo del ciclo. */
  waited?: boolean;
}

/** Transazione di Drizzle (parametro del callback di `db.transaction`). */
export type DbTransaction = Parameters<Parameters<typeof import("@workspace/db").db.transaction>[0]>[0];

export interface AuthConfig {
  header: string;
  scheme: string | null;
}

/** Header HTTP fisso (non segreto) dell'app. */
export interface ExtraHeader {
  name: string;
  value: string;
}

export interface AppConnection {
  baseUrl: string;
  internalBaseUrl: string | null;
  userAuth: AuthConfig | null;
  serviceAuth: AuthConfig | null;
  serviceSecretEnc: string | null;
  /** Indirizzo del server MCP dell'app (null se non ne espone uno) */
  mcpUrl: string | null;
  /** Header fissi mandati su ogni chiamata ai tool, HTTP e MCP (assenti = nessuno) */
  extraHeaders?: ExtraHeader[];
}
