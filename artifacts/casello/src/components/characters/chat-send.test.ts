import { describe, expect, it } from "vitest";
import { sendActions } from "./chat-send";

describe("sendActions", () => {
  it("a turno fermo c'è solo l'invio", () => {
    expect(sendActions({ running: false, readOnly: false, empty: false })).toEqual(["send"]);
  });
  it("durante il turno: «Invia subito» e «Accoda»", () => {
    expect(sendActions({ running: true, readOnly: false, empty: false })).toEqual(["now", "queue"]);
  });
  it("in sola lettura nessun pulsante", () => {
    expect(sendActions({ running: false, readOnly: true, empty: false })).toEqual([]);
    expect(sendActions({ running: true, readOnly: true, empty: false })).toEqual([]);
  });
  it("chat senza «Ferma»: durante il turno nessun invio, a turno fermo l'invio", () => {
    expect(sendActions({ running: true, readOnly: false, empty: false, interruptible: false })).toEqual([]);
    expect(sendActions({ running: false, readOnly: false, empty: false, interruptible: false })).toEqual(["send"]);
  });
  it("con il testo vuoto nessun pulsante", () => {
    expect(sendActions({ running: false, readOnly: false, empty: true })).toEqual([]);
    expect(sendActions({ running: true, readOnly: false, empty: true })).toEqual([]);
  });
});
