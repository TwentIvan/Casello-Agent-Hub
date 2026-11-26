import { describe, expect, it } from "vitest";
import {
  autoFixCounter,
  relightLabel,
  releaseTestElapsed,
  releaseTestLabel,
  releaseTestLed,
  releaseTestOpen,
  releaseTestProgress,
  releaseTestStepLine,
  tunnelRemaining,
} from "./release-test";

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

describe("avanzamento del collaudo", () => {
  it("frasi fisse per passo, senza argomenti", () => {
    expect(releaseTestStepLine({ type: "model", toolName: null })).toBe("Ragiona");
    expect(releaseTestStepLine({ type: "tool", toolName: "shell", args: { command: "cat .env" } })).toBe("Esegue un comando sul runner");
    expect(releaseTestStepLine({ type: "tool", toolName: "browser", args: { action: "open", url: "/x" } })).toBe("Apre una pagina nel browser");
    expect(releaseTestStepLine({ type: "tool", toolName: "browser", args: { action: "altro" } })).toBe("Usa il browser");
    expect(releaseTestStepLine({ type: "tool", toolName: "salva_ricetta" })).toBe("Salva la ricetta di avvio");
    expect(releaseTestStepLine({ type: "tool", toolName: "nuovo" })).toBe("Usa nuovo");
  });
  it("gli ultimi passi e il tempo trascorso", () => {
    const steps = Array.from({ length: 7 }, (_, i) => ({ type: "tool", toolName: i % 2 ? "shell" : "consegna_collaudo" }));
    expect(releaseTestProgress(steps)).toHaveLength(5);
    expect(releaseTestProgress(steps).at(-1)).toBe("Consegna l'esito");
    const now = new Date("2026-11-27T10:03:07Z");
    expect(releaseTestElapsed("2026-11-27T10:00:00Z", now)).toBe("3 min 07 s");
    expect(releaseTestElapsed("2026-11-27T10:02:20Z", now)).toBe("47 s");
    expect(releaseTestElapsed(null, now)).toBeNull();
  });
  it("stato della riaccensione", () => {
    expect(relightLabel({ status: "running", error: null })).toBe("Riaccensione in corso");
    expect(relightLabel({ status: "failed", error: "ricetta di avvio non riuscita" })).toBe("Riaccensione non riuscita: ricetta di avvio non riuscita");
  });
});
