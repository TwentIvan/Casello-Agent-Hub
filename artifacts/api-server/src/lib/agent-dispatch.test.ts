import { describe, expect, it, vi } from "vitest";
import { dispatchAgentCall, QUEUE_FIELDS_MISSING, queuedMessage } from "./agent-dispatch";
import type { StepRecord } from "./agent-loop";
import type { CatalogTool, ToolResult } from "./tools/types";

function makeTool(overrides: Partial<CatalogTool> & { name: string }): CatalogTool {
  const now = new Date(0);
  return {
    id: 1,
    appId: 1,
    description: `Descrizione di ${overrides.name}`,
    kind: "http",
    identity: "user",
    level: "L1",
    levelOverride: null,
    status: "active",
    paramsSchema: { type: "object", properties: {} },
    definition: { method: "GET", path: "/x", paramLocations: {} },
    evidence: null,
    needsVerification: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as CatalogTool;
}

const leggi = makeTool({ name: "leggi_rosa", level: "L0" });
const scambia = makeTool({
  name: "proponi_scambio",
  level: "L2",
  paramsSchema: {
    type: "object",
    properties: { da: { type: "string" }, a: { type: "string" } },
    required: ["da", "a"],
  },
});

function setup(executeTool?: (t: CatalogTool, a: Record<string, unknown>) => Promise<ToolResult>) {
  const steps: StepRecord[] = [];
  const exec = vi.fn(executeTool ?? (async () => ({ ok: true, content: "rosa: 11 giocatori", status: 200 })));
  const queue = vi.fn(async () => ({ ok: true as const, number: 7 }));
  const deps = {
    tools: [leggi, scambia],
    executeTool: exec,
    queueAction: queue,
    onStep: async (s: StepRecord) => {
      steps.push(s);
    },
  };
  return { deps, steps, exec, queue };
}

describe("dispatchAgentCall", () => {
  it("esegue un tool L0 e scrive il passo tool ok", async () => {
    const { deps, steps, exec } = setup();
    const text = await dispatchAgentCall({ id: "c1", name: "leggi_rosa", arguments: "" }, deps);
    expect(text).toBe("rosa: 11 giocatori");
    expect(exec).toHaveBeenCalledWith(leggi, {});
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "tool", toolName: "leggi_rosa", ok: true, httpStatus: 200 });
  });

  it("rifiuta un L2 senza destinatario e sintesi, senza accodare", async () => {
    const { deps, steps, queue } = setup();
    const text = await dispatchAgentCall(
      { id: "c1", name: "proponi_scambio", arguments: '{"da":"a","a":"b"}' },
      deps,
    );
    expect(text).toBe(QUEUE_FIELDS_MISSING);
    expect(queue).not.toHaveBeenCalled();
    expect(steps[0]).toMatchObject({ type: "tool", ok: false, error: QUEUE_FIELDS_MISSING, durationMs: 0 });
  });

  it("accoda un L2 completo senza destinatario e sintesi negli argomenti", async () => {
    const { deps, steps, queue } = setup();
    const text = await dispatchAgentCall(
      {
        id: "c1",
        name: "proponi_scambio",
        arguments: '{"da":"Totti","a":"Del Piero","destinatario":"Lazio","sintesi":"Totti per Del Piero"}',
      },
      deps,
    );
    expect(text).toBe(queuedMessage(7));
    expect(queue).toHaveBeenCalledWith(scambia, { da: "Totti", a: "Del Piero" }, "Lazio", "Totti per Del Piero");
    expect(steps[0]).toMatchObject({
      type: "queued",
      ok: true,
      queuedNumber: 7,
      recipient: "Lazio",
      summary: "Totti per Del Piero",
    });
  });

  it("risponde con un errore se lo strumento non esiste", async () => {
    const { deps, steps } = setup();
    const text = await dispatchAgentCall({ id: "c1", name: "x", arguments: "{}" }, deps);
    expect(text).toBe('Errore: lo strumento "x" non esiste');
    expect(steps[0]).toMatchObject({ type: "tool", toolName: "x", ok: false });
  });

  it("trasforma l'eccezione di executeTool in testo d'errore e passo ok false", async () => {
    const { deps, steps } = setup(async () => {
      throw new Error("rete giù");
    });
    const text = await dispatchAgentCall({ id: "c1", name: "leggi_rosa", arguments: "{}" }, deps);
    expect(text).toBe('Errore durante l\'esecuzione di "leggi_rosa": rete giù');
    expect(steps[0]).toMatchObject({ type: "tool", ok: false, error: text });
  });
});
