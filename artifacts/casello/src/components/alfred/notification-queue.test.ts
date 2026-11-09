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

  it("markSeen prima o dopo add: la run non si consegna", () => {
    const before = new NotificationQueue();
    before.markSeen("lead_run:12");
    before.add([run()]);
    expect(before.size()).toBe(0);
    const after = new NotificationQueue();
    after.add([run(), item()]);
    after.markSeen("lead_run:12");
    expect(after.size()).toBe(1);
    expect(after.takeMessage(quiet)).not.toContain("run 12");
    after.add([run()]);
    expect(after.size()).toBe(0);
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
      run({ run: 14, output: null, error: null, items: [] }),
      item({ numero: 10, tipo: "plan_change" }),
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("[novità]");
    expect(lines[1]).toBe("- Responsabile di The Hub Up, run 12, finita: «Riga uno riga due». Voci create: n. 7 (proposta) «Crea partner»");
    expect(lines[2]).toBe("- Responsabile di The Hub Up, run 13, non riuscita: «Errore brutto».");
    expect(lines[3]).toBe("- Nuova voce n. 8 (azione), squadra «Squadra A»: «Invia email».");
    expect(lines[4]).toBe("- Nuova voce n. 9 (azione): «Invia email».");
    expect(lines[5]).toBe("- Responsabile di The Hub Up, run 14, finita.");
    expect(lines[6]).toBe("- Nuova voce n. 10 (modifica del piano): «Invia email».");
    expect(lines).toHaveLength(7);
  });

  it("al più 10 righe di eventi, poi una riga con il resto", () => {
    const events = Array.from({ length: 13 }, (_, i) => item({ numero: i + 1 }));
    const lines = formatNotifications(events).split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[10]).toContain("n. 10");
    expect(lines[11]).toBe("- e altre 3 novità.");
  });
});
