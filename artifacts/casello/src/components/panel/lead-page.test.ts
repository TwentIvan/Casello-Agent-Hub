import { describe, expect, it } from "vitest";
import { leadPageFromPath } from "./page-subject";
import { CONSOLE_BOT_NAMES, TAB_LABELS, tabLabel, tabOrder } from "./tabs";
import { CHARACTER_TEXT } from "../characters/targets";
import { INITIAL_PANEL_STATE, panelReducer } from "./panel-state";

describe("leadPageFromPath", () => {
  it("copre le pagine della console", () => {
    expect(leadPageFromPath("/")).toEqual({ page: "dashboard" });
    expect(leadPageFromPath("/apps")).toEqual({ page: "apps" });
    expect(leadPageFromPath("/apps/3")).toEqual({ page: "app", id: "3" });
    expect(leadPageFromPath("/apps/3/plan")).toEqual({ page: "app_plan", id: "3" });
    expect(leadPageFromPath("/analyses/9")).toEqual({ page: "analysis", id: "9" });
    expect(leadPageFromPath("/agents")).toEqual({ page: "agents" });
    expect(leadPageFromPath("/agents/8")).toEqual({ page: "agent", id: "8" });
    expect(leadPageFromPath("/runs")).toEqual({ page: "runs" });
    expect(leadPageFromPath("/runs/")).toEqual({ page: "runs" });
    expect(leadPageFromPath("/runs/431")).toEqual({ page: "run", id: "431" });
    expect(leadPageFromPath("/pending-actions")).toEqual({ page: "pending_actions" });
    expect(leadPageFromPath("/skills")).toEqual({ page: "skills" });
    expect(leadPageFromPath("/skills/ruolo-capo")).toEqual({ page: "skill", id: "ruolo-capo" });
    expect(leadPageFromPath("/team-templates")).toEqual({ page: "team_templates" });
    expect(leadPageFromPath("/team-templates/2")).toEqual({ page: "team_template", id: "2" });
    expect(leadPageFromPath("/teams")).toEqual({ page: "teams" });
    expect(leadPageFromPath("/teams/12")).toEqual({ page: "team", id: "12" });
    expect(leadPageFromPath("/models")).toEqual({ page: "models" });
    expect(leadPageFromPath("/account")).toEqual({ page: "account" });
    expect(leadPageFromPath("/nodes/pair")).toEqual({ page: "console" });
    expect(leadPageFromPath("/alfred")).toEqual({ page: "console" });
  });

  it("id non valido: la pagina senza id", () => {
    expect(leadPageFromPath("/skills/a%20b")).toEqual({ page: "skill" });
    expect(leadPageFromPath(`/runs/${"9".repeat(101)}`)).toEqual({ page: "run" });
    expect(leadPageFromPath("/skills/%E0%A4%A")).toEqual({ page: "skill" });
  });
});

describe("schede per ambiente", () => {
  it("la scheda di Barbara, la Responsabile di Botcave, ha il suo nome", () => {
    expect(tabLabel("lead", CONSOLE_BOT_NAMES)).toBe("Barbara");
    expect(TAB_LABELS.lead).toBe("Responsabile");
    expect(CHARACTER_TEXT.responsabile).toEqual({ name: "Barbara", placeholder: "Scrivi a Barbara…", send: "Scrivi a Barbara" });
  });

  it("la scheda delle segnalazioni c'è solo nell'embed, quella del Responsabile in entrambi", () => {
    expect(tabOrder("embed")).toEqual(["alfred", "lucius", "lead", "pending", "bulletin", "bugs"]);
    expect(tabOrder("embed").at(-1)).toBe("bugs");
    expect(tabOrder("console")).not.toContain("bugs");
    expect(TAB_LABELS.bugs).toBe("Segnalazioni");
    expect(tabOrder("console")).toEqual(["alfred", "pending", "bulletin", "lucius", "lead"]);
  });

  it("il riduttore apre e seleziona la scheda di Barbara", () => {
    expect(panelReducer(INITIAL_PANEL_STATE, { type: "open", tab: "lead" })).toMatchObject({ open: true, tab: "lead" });
    expect(panelReducer(INITIAL_PANEL_STATE, { type: "selectTab", tab: "lead" }).tab).toBe("lead");
  });
});
