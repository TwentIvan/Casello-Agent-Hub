import type { AppTool } from "@workspace/db";

export type ToolKind = "http" | "ui" | "composite";
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

export type ToolDefinition = HttpDefinition | UiDefinition | CompositeDefinition;

// Riga di `app_tools` con schema dei parametri e definizione tipizzati
export type CatalogTool = Omit<AppTool, "paramsSchema" | "definition"> & {
  paramsSchema: Record<string, unknown>;
  definition: ToolDefinition;
};

export interface ToolResult {
  ok: boolean;
  status?: number;
  content: string;
}

export interface AuthConfig {
  header: string;
  scheme: string | null;
}

export interface AppConnection {
  baseUrl: string;
  internalBaseUrl: string | null;
  userAuth: AuthConfig | null;
  serviceAuth: AuthConfig | null;
  serviceSecretEnc: string | null;
}
