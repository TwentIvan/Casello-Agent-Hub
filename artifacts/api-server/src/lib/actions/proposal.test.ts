import { describe, expect, it } from "vitest";
import {
  PROPOSAL_MESSAGES,
  parseProposalArgs,
  planExclusion,
  resolveRefs,
  stepRefs,
} from "./proposal";

const step = (id: string, argomenti: unknown = {}, extra: object = {}) => ({
  id,
  strumento: "crea_voce",
  argomenti,
  sintesi: `Passo ${id}`,
  ...extra,
});

describe("parseProposalArgs", () => {
  it("traduce gli argomenti italiani", () => {
    const r = parseProposalArgs({
      titolo: "  Crea progetto  ",
      motivo: " dalla mail ",
      passi: [step("p1", { nome: "x" }), step("p2", { progetto: "{{p1.id}}" })],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        title: "Crea progetto",
        reason: "dalla mail",
        steps: [
          { key: "p1", toolName: "crea_voce", args: { nome: "x" }, summary: "Passo p1" },
          { key: "p2", toolName: "crea_voce", args: { progetto: "{{p1.id}}" }, summary: "Passo p2" },
        ],
      },
    });
  });

  it("salva il nome dello strumento senza spazi", () => {
    const r = parseProposalArgs({ titolo: "t", passi: [step("p1", {}, { strumento: "  crea_voce " })] });
    expect(r.ok && r.value.steps[0]!.toolName).toBe("crea_voce");
  });

  it("motivo vuoto o assente diventa null", () => {
    for (const motivo of [undefined, "   "]) {
      const r = parseProposalArgs({ titolo: "t", motivo, passi: [step("p1")] });
      expect(r.ok && r.value.reason).toBeNull();
    }
  });

  it("rifiuta titolo, motivo, numero di passi e sintesi fuori misura", () => {
    const bad = (a: Record<string, unknown>) =>
      expect(parseProposalArgs({ titolo: "t", passi: [step("p1")], ...a }).ok).toBe(false);
    bad({ titolo: "" });
    bad({ titolo: "   " });
    bad({ titolo: "a".repeat(201) });
    bad({ motivo: "a".repeat(1001) });
    bad({ passi: [] });
    bad({ passi: Array.from({ length: 21 }, (_, i) => step(`p${i + 1}`)) });
    bad({ passi: [step("p1", {}, { sintesi: "" })] });
    bad({ passi: [step("p1", {}, { sintesi: "a".repeat(301) })] });
    bad({ passi: [step("p1", [])] });
    bad({ passi: [step("p1", "x")] });
    bad({ passi: [step("p1", {}, { strumento: "" })] });
  });

  it("accetta 20 passi e limiti esatti", () => {
    const passi = Array.from({ length: 20 }, (_, i) => step(`p${i + 1}`));
    expect(parseProposalArgs({ titolo: "a".repeat(200), motivo: "m".repeat(1000), passi }).ok).toBe(true);
  });

  it("rifiuta id fuori ordine o ripetuti", () => {
    for (const ids of [["p2"], ["p1", "p1"], ["p1", "p3"]]) {
      const r = parseProposalArgs({ titolo: "t", passi: ids.map((i) => step(i)) });
      expect(r).toEqual({ ok: false, message: PROPOSAL_MESSAGES.badIds });
    }
    expect(PROPOSAL_MESSAGES.badIds).toBe("id dei passi non validi: p1, p2… nell'ordine");
  });

  it("controlla i riferimenti per posizione", () => {
    const run = (passi: unknown[]) => parseProposalArgs({ titolo: "t", passi });
    expect(run([step("p1"), step("p2", { a: "{{p1.id}}" })]).ok).toBe(true);
    for (const a of ["{{p2.id}}", "{{p3.id}}", "{{p9.id}}", "progetto {{p1.id}}"]) {
      expect(run([step("p1"), step("p2", { a }), step("p3")])).toEqual({
        ok: false,
        message: "riferimento non valido nel passo p2",
      });
    }
    expect(run([step("p1", { a: "{{p1.id}}" })])).toEqual({
      ok: false,
      message: PROPOSAL_MESSAGES.badRef("p1"),
    });
  });
});

describe("stepRefs", () => {
  it("trova i riferimenti con il loro percorso", () => {
    const r = stepRefs({
      projectId: "{{p1.id}}",
      dati: { cliente: "{{p2.cliente.nome}}", voci: [{ id: "{{p1.x.y}}" }, "ok"] },
      n: 3,
    });
    expect(r).toEqual([
      { param: "projectId", step: "p1", field: ["id"] },
      { param: "dati.cliente", step: "p2", field: ["cliente", "nome"] },
      { param: "dati.voci.0.id", step: "p1", field: ["x", "y"] },
    ]);
  });

  it("senza riferimenti dà elenco vuoto", () => {
    expect(stepRefs({ a: "x", b: "{ciao}", c: "{{nome}}" })).toEqual([]);
  });

  it("segnala le stringhe malformate", () => {
    const bad = [
      "x {{p1.id}}",
      "{{p1.id}} x",
      "{{p1}}",
      "{{p1.a.b.c.d.e.f}}",
      "{{p1.a b}}",
      "{{p21.id}}",
      "{{p0.id}}",
      "{{p1.}}",
    ];
    for (const s of bad) expect(stepRefs({ a: [s] }), s).toEqual({ badRef: true });
    expect(stepRefs({ a: "{{p1.a.b.c.d.e}}" })).toEqual([
      { param: "a", step: "p1", field: ["a", "b", "c", "d", "e"] },
    ]);
  });
});

describe("resolveRefs", () => {
  const results = new Map<string, unknown>([
    ["p1", { id: 7, data: { id: "abc" }, s: "t" }],
    ["p2", "testo"],
  ]);

  it("mantiene il tipo e non modifica l'input", () => {
    const input = { a: "{{p1.id}}", b: { c: "{{p1.data.id}}", d: ["{{p1.s}}", 1] }, e: "fisso" };
    const copy = JSON.parse(JSON.stringify(input));
    const r = resolveRefs(input, results);
    expect(r).toEqual({ ok: true, args: { a: 7, b: { c: "abc", d: ["t", 1] }, e: "fisso" } });
    expect(input).toEqual(copy);
  });

  it("fallisce su campo mancante, risultato non oggetto o proprietà ereditate", () => {
    for (const ref of [
      "{{p1.nope}}",
      "{{p1.s.length}}",
      "{{p2.x}}",
      "{{p3.id}}",
      "{{p1.__proto__}}",
      "{{p1.constructor}}",
      "{{p1.data.toString}}",
    ]) {
      expect(resolveRefs({ a: ref }, results), ref).toEqual({ ok: false });
    }
  });
});

describe("planExclusion", () => {
  const chain = [
    { key: "p1", refs: [] },
    { key: "p2", refs: [{ param: "a", step: "p1", field: ["id"] }] },
    { key: "p3", refs: [{ param: "a", step: "p2", field: ["id"] }] },
  ];

  it("escludere la testa della catena non lascia nulla da eseguire", () => {
    expect(planExclusion(chain, ["p1"])).toEqual({ ok: false, message: PROPOSAL_MESSAGES.nothingToRun });
  });

  it("salta i passi che dipendono dagli esclusi", () => {
    const steps = [...chain, { key: "p4", refs: [] }];
    const r = planExclusion(steps, ["p2"]);
    expect(r).toEqual({ ok: true, excluded: new Set(["p2"]), skipped: new Set(["p3"]) });
    const r1 = planExclusion(steps, ["p1"]);
    expect(r1).toEqual({ ok: true, excluded: new Set(["p1"]), skipped: new Set(["p2", "p3"]) });
  });

  it("rifiuta id ripetuti o sconosciuti", () => {
    for (const ex of [["p1", "p1"], ["p9"]]) {
      expect(planExclusion(chain, ex)).toEqual({ ok: false, message: PROPOSAL_MESSAGES.badExclude });
    }
  });

  it("senza esclusioni non cambia nulla", () => {
    expect(planExclusion(chain, [])).toEqual({ ok: true, excluded: new Set(), skipped: new Set() });
  });
});

describe("messaggi", () => {
  it("sono quelli della spec", () => {
    expect(PROPOSAL_MESSAGES.alreadyProposed).toBe("hai già proposto in questa run: usa la discussione");
    expect(PROPOSAL_MESSAGES.badExclude).toBe("passi da escludere non validi");
    expect(PROPOSAL_MESSAGES.nothingToRun).toBe("nessun passo da eseguire: rifiuta la proposta");
    expect(PROPOSAL_MESSAGES.unresolved).toBe("riferimento non risolto");
    expect(PROPOSAL_MESSAGES.toolUnusable).toBe("strumento non più utilizzabile");
    expect(PROPOSAL_MESSAGES.stoppedAt(2, 4, "p3")).toBe("eseguiti 2 passi su 4: si è fermata al passo p3");
  });
});
