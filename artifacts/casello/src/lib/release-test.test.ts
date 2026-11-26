import { describe, expect, it } from "vitest";
import { autoFixCounter, releaseTestLabel, releaseTestLed, releaseTestOpen, tunnelRemaining } from "./release-test";

describe("releaseTestLed", () => {
  it("un LED per stato ed esito", () => {
    expect(releaseTestLed({ status: "queued", outcome: null })).toBe("work");
    expect(releaseTestLed({ status: "dispatching", outcome: null })).toBe("work");
    expect(releaseTestLed({ status: "running", outcome: null })).toBe("work");
    expect(releaseTestLed({ status: "done", outcome: "ok" })).toBe("ok");
    expect(releaseTestLed({ status: "done", outcome: "problems" })).toBe("ko");
    expect(releaseTestLed({ status: "done", outcome: "not_startable" })).toBe("ko");
    expect(releaseTestLed({ status: "failed", outcome: null })).toBe("ko");
    expect(releaseTestLed({ status: "skipped", outcome: null })).toBe("idle");
    expect(releaseTestLed({ status: "cancelled", outcome: null })).toBe("idle");
  });
  it("segna i collaudi aperti", () => {
    expect(releaseTestOpen("running")).toBe(true);
    expect(releaseTestOpen("done")).toBe(false);
  });
});

describe("releaseTestLabel", () => {
  it("frasi fisse", () => {
    expect(releaseTestLabel({ status: "queued", outcome: null })).toBe("Collaudo in coda");
    expect(releaseTestLabel({ status: "running", outcome: null })).toBe("Collaudo in corso");
    expect(releaseTestLabel({ status: "done", outcome: "ok" })).toBe("Collaudo superato");
    expect(releaseTestLabel({ status: "done", outcome: "problems" })).toBe("Problemi trovati");
    expect(releaseTestLabel({ status: "done", outcome: "not_startable" })).toBe("L'App non si avvia");
    expect(releaseTestLabel({ status: "skipped", outcome: null, error: "nessuna ricetta" })).toBe("Collaudo saltato: nessuna ricetta");
    expect(releaseTestLabel({ status: "failed", outcome: null, error: "tempo scaduto" })).toBe("Collaudo non riuscito: tempo scaduto");
    expect(releaseTestLabel({ status: "cancelled", outcome: null })).toBe("Collaudo annullato");
  });
});

describe("tunnelRemaining", () => {
  const now = new Date("2026-11-26T10:00:00Z");
  it("minuti residui", () => expect(tunnelRemaining("2026-11-26T10:23:30Z", now)).toBe("23 min"));
  it("null se scaduto", () => expect(tunnelRemaining("2026-11-26T09:59:00Z", now)).toBeNull());
});

describe("autoFixCounter", () => {
  it("n di 2", () => expect(autoFixCounter(1)).toBe("correzioni automatiche 1 di 2"));
});
