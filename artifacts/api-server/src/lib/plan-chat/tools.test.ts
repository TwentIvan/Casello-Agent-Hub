import { describe, expect, it } from "vitest";
import { PlanToolRunner, type NewProposal, type PlanToolEnv, type PlanToolItem } from "./tools";

const completionPayload = (key: string, dependsOn: string[] = []) => ({
  key,
  phase: 1,
  area: "api",
  title: "Aggiungere gli ordini",
  missing: "manca",
  evidence: [],
  goal: "obiettivo",
  dependsOn,
  files: [],
  effort: "S",
  doneWhen: "fatto",
  implementation: "come",
});

function makeEnv() {
  const saved: NewProposal[] = [];
  const item: PlanToolItem = { id: 7, ref: "c1", chapter: "completion", payload: completionPayload("k1"), status: "proposed", evidence: [{ file: "a.ts" }] };
  const env: PlanToolEnv = {
    items: new Map([["c1", item]]),
    readApp: async (slug) => (slug === "mister" ? "scheda di mister" : null),
    saveProposal: async (p) => {
      saved.push(p);
      return saved.length;
    },
    hash: (it) => `h:${it.id}`,
  };
  return { env, saved, item };
}

const call = (name: string, args: unknown) => ({ id: "t1", name, arguments: JSON.stringify(args) });

describe("PlanToolRunner", () => {
  it("read_item restituisce payload ed evidence", async () => {
    const { env, item } = makeEnv();
    const out = await new PlanToolRunner(env).run(call("read_item", { ref: "c1" }));
    expect(JSON.parse(out)).toEqual({ payload: item.payload, evidence: item.evidence });
  });

  it("read_item con ref sconosciuta", async () => {
    const out = await new PlanToolRunner(makeEnv().env).run(call("read_item", { ref: "zzz" }));
    expect(out).toBe("voce non trovata: zzz");
  });

  it("read_app restituisce la scheda o app non trovata", async () => {
    const r = new PlanToolRunner(makeEnv().env);
    expect(await r.run(call("read_app", { slug: "mister" }))).toBe("scheda di mister");
    expect(await r.run(call("read_app", { slug: "x" }))).toBe("app non trovata: x");
  });

  it("propose add valida salva la proposta", async () => {
    const { env, saved } = makeEnv();
    const out = await new PlanToolRunner(env).run(
      call("propose", { kind: "add", chapter: "completion", payload: completionPayload("k2", ["k1"]), rationale: "serve" }),
    );
    expect(out).toBe("proposta registrata (#1): l'utente la vedrà come scheda");
    expect(saved[0]).toMatchObject({ kind: "add", chapter: "completion", targetItemId: null, targetHash: null, rationale: "serve" });
  });

  it("propose update salva l'hash della voce", async () => {
    const { env, saved, item } = makeEnv();
    await new PlanToolRunner(env).run(
      call("propose", { kind: "update", chapter: "completion", targetRef: "c1", payload: completionPayload("k1"), rationale: "r" }),
    );
    expect(saved[0].targetItemId).toBe(7);
    expect(saved[0].targetHash).toBe(env.hash(item));
  });

  it("propose discard non richiede il payload", async () => {
    const { env, saved } = makeEnv();
    await new PlanToolRunner(env).run(call("propose", { kind: "discard", chapter: "completion", targetRef: "c1", rationale: "r" }));
    expect(saved[0]).toMatchObject({ kind: "discard", payload: null, targetItemId: 7 });
  });

  it("propose con payload non valido restituisce gli errori e non salva", async () => {
    const { env, saved } = makeEnv();
    const out = await new PlanToolRunner(env).run(call("propose", { kind: "add", chapter: "completion", payload: { key: "" }, rationale: "r" }));
    expect(out.startsWith("proposta non valida:\n")).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("propose con dependsOn sconosciuta è non valida", async () => {
    const { env, saved } = makeEnv();
    const out = await new PlanToolRunner(env).run(
      call("propose", { kind: "add", chapter: "completion", payload: completionPayload("k2", ["nope"]), rationale: "r" }),
    );
    expect(out).toContain("nope");
    expect(saved).toHaveLength(0);
  });

  it("propose su una ref di un altro capitolo o inesistente è non valida", async () => {
    const { env, saved } = makeEnv();
    const r = new PlanToolRunner(env);
    const other = await r.run(call("propose", { kind: "discard", chapter: "evolution", targetRef: "c1", rationale: "r" }));
    const missing = await r.run(call("propose", { kind: "discard", chapter: "completion", targetRef: "zz", rationale: "r" }));
    expect(other.startsWith("proposta non valida")).toBe(true);
    expect(missing.startsWith("proposta non valida")).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("rationale vuota o capitolo errato sono non validi; JSON rotto non lancia", async () => {
    const r = new PlanToolRunner(makeEnv().env);
    expect(await r.run(call("propose", { kind: "discard", chapter: "completion", targetRef: "c1", rationale: " " }))).toContain("rationale");
    expect(await r.run(call("propose", { kind: "discard", chapter: "tool", targetRef: "c1", rationale: "r" }))).toContain("chapter");
    expect(await new PlanToolRunner(makeEnv().env).run({ id: "x", name: "propose", arguments: "{" })).toContain("proposta non valida");
    expect(await r.run(call("boh", {}))).toContain("strumento sconosciuto");
  });

  it("alla terza proposta non valida le correzioni sono esaurite", async () => {
    const { env, saved } = makeEnv();
    const r = new PlanToolRunner(env);
    const bad = call("propose", { kind: "add", chapter: "completion", payload: {}, rationale: "r" });
    expect((await r.run(bad)).startsWith("proposta non valida")).toBe(true);
    expect((await r.run(bad)).startsWith("proposta non valida")).toBe(true);
    expect(await r.run(bad)).toBe("correzioni esaurite: non proporre altro in questo turno");
    const good = call("propose", { kind: "discard", chapter: "completion", targetRef: "c1", rationale: "r" });
    expect(await r.run(good)).toBe("correzioni esaurite: non proporre altro in questo turno");
    expect(saved).toHaveLength(0);
  });
});
