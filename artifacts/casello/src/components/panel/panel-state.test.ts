import { describe, expect, it } from "vitest";
import type { ChatTarget } from "../characters/adapters";
import { INITIAL_PANEL_STATE, luciusTarget, panelReducer, type PanelState } from "./panel-state";

const base = (over: Partial<PanelState> = {}): PanelState => ({ ...INITIAL_PANEL_STATE, ...over });
const plan: ChatTarget = { kind: "plan", appId: 1 };
const agent: ChatTarget = { kind: "character", subjectType: "agent", subjectId: "5", title: "" };

describe("panelReducer", () => {
  it("stato iniziale chiuso sulla scheda alfred", () => {
    expect(INITIAL_PANEL_STATE).toEqual({ open: false, tab: "alfred", draft: null, nonce: 0, pageLucius: null, override: null });
  });
  it("open senza scheda apre sulla scheda corrente", () => {
    const s = panelReducer(base({ tab: "pending" }), { type: "open" });
    expect(s.open).toBe(true);
    expect(s.tab).toBe("pending");
  });
  it("open con scheda la seleziona", () => {
    expect(panelReducer(base(), { type: "open", tab: "bulletin" })).toMatchObject({ open: true, tab: "bulletin" });
  });
  it("close chiude e lascia la scheda", () => {
    expect(panelReducer(base({ open: true, tab: "pending" }), { type: "close" })).toMatchObject({ open: false, tab: "pending" });
  });
  it("selectTab cambia scheda", () => {
    expect(panelReducer(base(), { type: "selectTab", tab: "lucius" }).tab).toBe("lucius");
  });
  it("handoff verso Alfred", () => {
    const s = panelReducer(base({ tab: "lucius", override: agent }), {
      type: "handoff",
      target: { kind: "alfred", page: { page: "console" } },
      draft: "ciao",
    });
    expect(s).toMatchObject({ open: true, tab: "alfred", draft: { tab: "alfred", text: "ciao" }, nonce: 1, override: agent });
  });
  it("handoff verso Lucius su un altro argomento sostituisce", () => {
    const s = panelReducer(base({ pageLucius: plan }), { type: "handoff", target: agent, draft: "x" });
    expect(s).toMatchObject({ open: true, tab: "lucius", override: agent, draft: { tab: "lucius", text: "x" }, nonce: 1 });
    expect(luciusTarget(s)).toEqual(agent);
  });
  it("handoff verso Lucius sull'argomento della pagina non sostituisce", () => {
    const s = panelReducer(base({ pageLucius: plan, override: agent }), { type: "handoff", target: { kind: "plan", appId: 1 }, draft: "x" });
    expect(s.override).toBeNull();
    expect(s.tab).toBe("lucius");
    expect(s.draft).toEqual({ tab: "lucius", text: "x" });
    expect(s.nonce).toBe(1);
  });
  it("la bozza si usa una sola volta: close, selectTab e open la tolgono senza toccare nonce", () => {
    const h = panelReducer(base(), { type: "handoff", target: agent, draft: "x" });
    for (const a of [{ type: "close" }, { type: "selectTab", tab: "pending" }, { type: "open" }] as const) {
      const s = panelReducer(h, a);
      expect(s.draft).toBeNull();
      expect(s.nonce).toBe(h.nonce);
    }
  });
  it("open con clearOverride mostra l'argomento della pagina", () => {
    const s = panelReducer(base({ pageLucius: plan, override: agent }), { type: "open", tab: "lucius", clearOverride: true });
    expect(s.override).toBeNull();
    expect(luciusTarget(s)).toEqual(plan);
    expect(panelReducer(base({ override: agent }), { type: "open", tab: "lucius" }).override).toEqual(agent);
  });
  it("navigate chiude e toglie la sostituzione", () => {
    const s = panelReducer(
      base({ open: true, pageLucius: plan, override: agent, draft: { tab: "lucius", text: "x" } }),
      { type: "navigate" },
    );
    expect(s).toMatchObject({ open: false, override: null, draft: null, pageLucius: plan });
  });
  it("setPageSubject cambia l'argomento senza toccare la sostituzione", () => {
    const s = panelReducer(base({ override: agent }), { type: "setPageSubject", lucius: plan });
    expect(s).toMatchObject({ pageLucius: plan, override: agent });
  });
  it("clearOverride riporta all'argomento della pagina", () => {
    const s = panelReducer(base({ pageLucius: plan, override: agent }), { type: "clearOverride" });
    expect(luciusTarget(s)).toEqual(plan);
  });
});
