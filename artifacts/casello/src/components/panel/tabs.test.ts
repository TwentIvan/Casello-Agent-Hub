import { describe, expect, it } from "vitest";
import { CONSOLE_BOT_NAMES, TAB_LABELS, tabLabel, tabOrder } from "./tabs";
import { writeTo } from "../characters/targets";

describe("schede del pannello", () => {
  it("embed: i tre bot, poi coda, bollettino e segnalazioni", () => {
    expect(tabOrder("embed")).toEqual(["alfred", "lucius", "lead", "pending", "bulletin", "bugs"]);
  });

  it("console: ordine invariato", () => {
    expect(tabOrder("console")).toEqual(["alfred", "pending", "bulletin", "lucius", "lead"]);
  });

  it("le etichette dei bot vengono dai nomi dell'App", () => {
    const names = { alfred: "A", lucius: "L", lead: "Bea" };
    expect(tabLabel("lead", names)).toBe("Bea");
    expect(tabLabel("alfred", names)).toBe("A");
    expect(tabLabel("lucius", names)).toBe("L");
    expect(tabLabel("pending", names)).toBe("Da confermare");
    expect(tabLabel("bugs", names)).toBe("Segnalazioni");
  });

  it("senza nomi: Alfred, Lucius, Responsabile", () => {
    expect(tabLabel("alfred", null)).toBe("Alfred");
    expect(tabLabel("lucius", null)).toBe("Lucius");
    expect(tabLabel("lead", null)).toBe("Responsabile");
    expect(TAB_LABELS.bulletin).toBe("Bollettino");
  });

  it("nella console la Responsabile resta Barbara", () => {
    expect(tabLabel("lead", CONSOLE_BOT_NAMES)).toBe("Barbara");
  });
});

describe("writeTo", () => {
  it("«ad» davanti alla a, «a» altrimenti", () => {
    expect(writeTo("Alfred")).toBe("ad Alfred");
    expect(writeTo("anna")).toBe("ad anna");
    expect(writeTo("Bea")).toBe("a Bea");
    expect(writeTo("Elena")).toBe("a Elena");
  });
});
