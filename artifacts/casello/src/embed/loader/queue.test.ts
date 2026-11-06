import { describe, expect, it } from "vitest";
import { createOutbox } from "./queue";
import type { ToFrame } from "../protocol";

const ctx = (page: string): ToFrame => ({ botcave: 1, type: "context", payload: { page } });
const theme: ToFrame = { botcave: 1, type: "theme", payload: { mode: "light", vars: {} } };
const open: ToFrame = { botcave: 1, type: "open", payload: {} };

describe("createOutbox", () => {
  it("prima di ready tiene solo l'ultimo messaggio per tipo e li consegna in ordine", () => {
    const sent: ToFrame[] = [];
    const box = createOutbox((m) => sent.push(m));
    box.send(open);
    box.send(ctx("a"));
    box.send(ctx("b"));
    box.send(ctx("c"));
    box.send(theme);
    expect(sent).toEqual([]);
    box.ready();
    expect(sent).toEqual([theme, ctx("c"), open]);
  });

  it("dopo ready consegna subito", () => {
    const sent: ToFrame[] = [];
    const box = createOutbox((m) => sent.push(m));
    box.ready();
    box.send(ctx("x"));
    expect(sent).toEqual([ctx("x")]);
  });

  it("reset dopo ready → torna a tenere i messaggi e li consegna al nuovo ready, compresi gli ultimi theme e context", () => {
    const sent: ToFrame[] = [];
    const box = createOutbox((m) => sent.push(m));
    box.send(theme);
    box.send(ctx("a"));
    box.ready();
    sent.length = 0;
    box.reset();
    box.send(ctx("b"));
    expect(sent).toEqual([]);
    box.ready();
    expect(sent).toEqual([theme, ctx("b")]);
    sent.length = 0;
    box.reset();
    box.ready();
    expect(sent).toEqual([theme, ctx("b")]);
  });
});
