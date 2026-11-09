import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TOOL_NAME, checkParamsSchema, checkPathPlaceholders, parseDefinition } from "../src/lib/tools/definition";
import type { HttpDefinition } from "../src/lib/tools/types";

// Controllo del catalogo dei tool di Botcave come App di sé stesso (docs/botcave-self/catalogo-tool.json, spec §5):
// ogni tool è valido per le route dei tool, punta a una route vera di openapi.yaml e mai a una route vietata o esclusa.

// lib/auth legge la configurazione del login all'import: senza variabili si importa con AUTH_DISABLED, come gli altri test
process.env.AUTH_DISABLED ??= "true";
const { AGENT_DENIED_ROUTES } = await import("../src/lib/auth");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

type CatalogTool = {
  name: string;
  description: string;
  kind: string;
  identity: string;
  level: string;
  status: string;
  paramsSchema: object;
  definition: HttpDefinition;
  replaces?: string;
};

const catalog = JSON.parse(read("../../../docs/botcave-self/catalogo-tool.json")) as CatalogTool[];
const openapi = parse(read("../../../lib/api-spec/openapi.yaml")) as { paths: Record<string, Record<string, unknown>> };

const METHODS = ["get", "post", "put", "patch", "delete"];
const normalize = (path: string) => path.replace(/\{[^{}]+\}/g, "{}");
const OPENAPI_ROUTES = new Set(
  Object.entries(openapi.paths).flatMap(([path, ops]) =>
    Object.keys(ops)
      .filter((m) => METHODS.includes(m))
      .map((m) => `${m.toUpperCase()} ${normalize(path)}`),
  ),
);

/** Path relativo a /api, come lo vedono le route e AGENT_DENIED_ROUTES. */
const apiPath = (tool: CatalogTool) => tool.definition.path.replace(/^\/api(?=\/)/, "");

// Spec §5.1 (letture) e §5.2 (scritture)
const READS = [
  "list_apps", "get_app_overview", "list_app_tools", "list_agents", "get_agent", "list_agent_skills",
  "list_agent_triggers", "get_trigger", "list_trigger_runs", "test_trigger",
  "list_runs", "get_run", "get_run_steps", "get_dashboard_stats", "get_budget",
  "list_app_analyses", "get_analysis", "get_analysis_issues", "get_app_plan",
  "list_skills", "get_skill", "list_skill_versions", "get_skill_version",
  "list_team_templates", "get_team_template",
  "list_team_instances", "get_team_instance", "get_team_plan", "list_team_tasks", "get_team_task", "list_team_turns",
  "list_team_events", "get_team_updates",
  "list_pending_actions", "get_pending_action",
  "list_ai_models", "search_model_catalog", "get_catalog_status",
];
const WRITES: Record<string, string> = {
  create_area_agent: "L2", update_agent: "L2", set_agent_tools: "L2", trigger_run: "L2", cancel_run: "L1",
  create_app_tool: "L2", update_app_tool: "L2", refresh_mcp_tools: "L2", create_trigger: "L1", pause_trigger: "L1",
  resume_trigger: "L2", start_analysis: "L2", cancel_analysis: "L1", create_plan_issues: "L2", create_skill: "L2",
  update_skill: "L2", deprecate_skill: "L2", create_team_template: "L2", update_team_template: "L2",
  create_team_instance: "L2", update_team_instance: "L2", apply_team_updates: "L2", activate_team: "L2", close_team: "L2",
  send_message_to_lead: "L2", set_team_budget: "L2", refresh_model_catalog: "L2",
};
const DISABLED = ["resume_run", "review_analysis_item"];
// I 23 tool oggi in produzione sull'App 4: si aggiornano al posto di crearne di nuovi
const EXISTING = [
  "list_apps", "get_app_overview", "list_app_tools", "list_agents", "get_agent", "create_area_agent", "update_agent",
  "set_agent_tools", "trigger_run", "list_runs", "get_run", "get_run_steps", "resume_run", "get_dashboard_stats",
  "list_app_analyses", "start_analysis", "get_analysis", "review_analysis_item", "get_analysis_issues", "cancel_analysis",
  "list_ai_models", "search_model_catalog", "refresh_model_catalog",
];

// Spec §5.3: route escluse (sessionOnly, chiamate a modelli, allegati, segreti, configurazione delle app…)
function excludedReason(method: string, path: string): string | null {
  const p = normalize(path);
  const anywhere: Array<[RegExp, string]> = [
    [/^\/account\//, "account"],
    [/^\/ai\/accounts/, "account AI"],
    [/^\/node\//, "nodo"],
    [/^\/alfred\//, "alfred"],
    [/^\/embed\//, "embed"],
    [/^\/hooks\//, "webhook"],
    [/^\/memories\//, "memorie"],
    [/^\/characters\//, "personaggi"],
    [/^\/character-/, "personaggi"],
    [/\/plan-conversations/, "chat del piano"],
    [/\/team-chat-/, "chat di squadra"],
    [/^\/github\//, "github"],
    [/^\/auth\//, "auth"],
    [/^\/ai\/estimate/, "stima dei costi"],
    [/\/attachments/, "allegati"],
    [/^\/apps\/\{\}\/agent-models/, "modelli degli agenti"],
    [/^\/triggers\/\{\}\/secret/, "segreto del webhook"],
    [/^\/triggers\/\{\}\/signing-secret/, "segreto di firma"],
  ];
  for (const [re, reason] of anywhere) if (re.test(p)) return reason;
  if (method === "DELETE") return "DELETE";
  if (method !== "GET" && /^\/budget/.test(p)) return "tetto personale";
  if (method === "PATCH" && /^\/ai\/models\/\{\}$/.test(p)) return "prezzi e tetti dei modelli";
  if ((method === "POST" || method === "PATCH") && /^\/apps(\/\{\})?$/.test(p)) return "configurazione delle app";
  return null;
}

describe("catalogo dei tool di Botcave come App di sé stesso", () => {
  it("contiene esattamente i tool della spec, con i livelli della tabella", () => {
    const names = catalog.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...READS, ...Object.keys(WRITES), ...DISABLED].sort());
    for (const t of catalog) {
      if (READS.includes(t.name)) expect(t.level, t.name).toBe("L0");
      if (t.name in WRITES) expect(t.level, t.name).toBe(WRITES[t.name]);
      expect(t.status, t.name).toBe(DISABLED.includes(t.name) ? "disabled" : "active");
      expect(t.replaces, t.name).toBe(EXISTING.includes(t.name) ? t.name : undefined);
    }
  });

  it.each(catalog.map((t) => [t.name, t] as const))("%s è un tool valido", (_name, t) => {
    expect(TOOL_NAME.test(t.name)).toBe(true);
    expect(t.kind).toBe("http");
    expect(t.identity).toBe("service");
    expect(["L0", "L1", "L2"]).toContain(t.level);
    expect(typeof t.description === "string" && t.description.length > 0).toBe(true);
    const parsed = parseDefinition("http", t.definition);
    expect(parsed.ok ? null : parsed.error).toBeNull();
    expect(checkParamsSchema(t.paramsSchema)).toBeNull();
    expect(checkPathPlaceholders(t.definition, t.paramsSchema)).toBeNull();
    expect(t.definition.path.startsWith("/api/")).toBe(true);
    // Le chiavi accettate da POST /api/apps/:id/tools, più `replaces`
    const allowed = ["name", "description", "kind", "identity", "level", "status", "paramsSchema", "definition", "replaces"];
    expect(Object.keys(t).filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it.each(catalog.map((t) => [t.name, t] as const))("%s punta a una route ammessa", (name, t) => {
    const method = t.definition.method;
    const path = apiPath(t);
    if (name !== "resume_run") expect(OPENAPI_ROUTES.has(`${method} ${normalize(path)}`), `${method} ${path}`).toBe(true);
    if (t.level === "L0" && name !== "test_trigger") expect(method).toBe("GET");
    if (name !== "review_analysis_item") {
      const probe = path.replace(/\{[^{}]+\}/g, "1");
      expect(AGENT_DENIED_ROUTES.some((r) => r.method === method && r.path.test(probe)), `${method} ${probe}`).toBe(false);
    }
    expect(excludedReason(method, path)).toBeNull();
  });

  it("trigger_run non passa il token dell'utente", () => {
    const run = catalog.find((t) => t.name === "trigger_run")!;
    const props = Object.keys((run.paramsSchema as { properties?: object }).properties ?? {});
    expect(props.some((p) => /token/i.test(p))).toBe(false);
  });

  it("il controllo delle esclusioni riconosce le route vietate", () => {
    expect(excludedReason("POST", "/apps")).not.toBeNull();
    expect(excludedReason("PATCH", "/apps/{id}")).not.toBeNull();
    expect(excludedReason("DELETE", "/agents/{id}")).not.toBeNull();
    expect(excludedReason("PUT", "/budget")).not.toBeNull();
    expect(excludedReason("POST", "/team-instances/{id}/team-chat-conversations")).not.toBeNull();
    expect(excludedReason("GET", "/team-instances/{id}/attachments")).not.toBeNull();
    expect(excludedReason("PUT", "/team-instances/{id}/budget")).toBeNull();
    expect(excludedReason("GET", "/budget")).toBeNull();
  });
});
