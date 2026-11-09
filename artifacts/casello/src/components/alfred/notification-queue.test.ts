import { describe, expect, it } from "vitest";
import type { AlfredNotification } from "@workspace/api-client-react";
import { NotificationQueue, formatNotifications, notificationKey } from "./notification-queue";

const run = (over: Partial<AlfredNotification> = {}): AlfredNotification => ({
  kind: "lead_run",
  at: "2026-11-09T10:00:00.000Z",
  run: 12,
  app: "The Hub Up",
  status: "succeeded",
  output: "Fatto",
  error: null,
  items: [{ numero: 7, tipo: "proposal", sintesi: "Crea partner" }],
  ...over,
});
const item = (over: Partial<AlfredNotification> = {}): AlfredNotification => ({
  kind: "queue_item",
  at: "2026-11-09T10:00:01.000Z",
  numero: 8,
  tipo: "action",
  squadra: null,
  sintesi: "Invia email",
  ...over,
});
const quiet = { modelSpeaking: false, toolRunning: false, lastUserSpeechAt: null, now: 100_000 };

describe("notificationKey", () => {
  it("distingue run e voci", () => {
    expect(notificationKey(run())).toBe("lead_run:12");
    expect(notificationKey(item())).toBe("queue_item:8");
  });
});

describe("NotificationQueue", () => {
  it("ignora i doppioni, anche dopo la consegna", () => {
    const q = new NotificationQueue();
    q.add([run(), run()]);
    expect(q.size()).toBe(1);
    expect(q.takeMessage(quiet)).not.toBeNull();
    q.add([run()]);
    expect(q.size()).toBe(0);
  });

  it("non consegna se il modello parla, uno strumento gira o l'utente ha parlato da poco", () => {
    const q = new NotificationQueue();
    q.add([item()]);
    expect(q.takeMessage({ ...quiet, modelSpeaking: true })).toBeNull();
    expect(q.takeMessage({ ...quiet, toolRunning: true })).toBeNull();
    expect(q.takeMessage({ ...quiet, lastUserSpeechAt: 98_500 })).toBeNull();
    expect(q.size()).toBe(1);
    expect(q.takeMessage({ ...quiet, lastUserSpeechAt: 97_000 })).not.toBeNull();
  });

  it("con la coda vuota dà null e dopo la consegna si svuota", () => {
    const q = new NotificationQueue();
    expect(q.takeMessage(quiet)).toBeNull();
    q.add([item()]);
    q.takeMessage(quiet);
    expect(q.size()).toBe(0);
    expect(q.takeMessage(quiet)).toBeNull();
  });
});

describe("formatNotifications", () => {
  it("scrive le due forme di riga, appiattite", () => {
    const text = formatNotifications([
      run({ output: "Riga uno\n\nriga   due" }),
      run({ run: 13, status: "failed", output: null, error: "Errore\nbrutto", items: [] }),
      item({ squadra: "Squadra A" }),
      item({ numero: 9 }),
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("[novità]");
    expect(lines[1]).toBe("- Responsabile di The Hub Up, run 12, finita: Riga uno riga due. Voci create: n. 7 (proposal) Crea partner");
    expect(lines[2]).toBe("- Responsabile di The Hub Up, run 13, non riuscita: Errore brutto.");
    expect(lines[3]).toBe("- Nuova voce n. 8 (action), squadra Squadra A: Invia email.");
    expect(lines[4]).toBe("- Nuova voce n. 9 (action): Invia email.");
    expect(lines).toHaveLength(5);
  });
});
