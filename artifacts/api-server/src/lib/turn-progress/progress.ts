// Registro in memoria dei passi dei turni di chat in corso: la console lo legge con il polling
// della conversazione. Niente DB: una voce vive solo per la durata del turno.

export const PROGRESS_MAX_STEPS = 8;
export const PROGRESS_MAX_COUNTED = 200;

export type TurnConsumer = "plan_chat" | "team_chat" | "character";

export type TurnProgressView = {
  startedAt: string;
  steps: { text: string; status: "running" | "done" }[];
  omitted: number;
};

type Entry = {
  startedAt: string;
  steps: { id: number; text: string; status: "running" | "done" }[];
  counted: number;
  omitted: number;
};

const entries = new Map<string, Entry>();

const keyOf = (c: TurnConsumer, refId: number) => `${c}:${refId}`;

export function beginTurnProgress(c: TurnConsumer, refId: number): void {
  entries.set(keyOf(c, refId), { startedAt: new Date().toISOString(), steps: [], counted: 0, omitted: 0 });
}

/** Id del passo, null se la voce non c'è o il turno ha superato i passi contati. */
export function startStep(c: TurnConsumer, refId: number, text: string): number | null {
  const entry = entries.get(keyOf(c, refId));
  if (!entry || entry.counted >= PROGRESS_MAX_COUNTED) return null;
  entry.counted += 1;
  const id = entry.counted;
  entry.steps.push({ id, text, status: "running" });
  if (entry.steps.length > PROGRESS_MAX_STEPS) {
    entry.steps.shift();
    entry.omitted += 1;
  }
  return id;
}

export function finishStep(c: TurnConsumer, refId: number, stepId: number | null): void {
  if (stepId === null) return;
  const step = entries.get(keyOf(c, refId))?.steps.find((s) => s.id === stepId);
  if (step) step.status = "done";
}

export function endTurnProgress(c: TurnConsumer, refId: number): void {
  entries.delete(keyOf(c, refId));
}

export function readTurnProgress(c: TurnConsumer, refId: number): TurnProgressView | null {
  const entry = entries.get(keyOf(c, refId));
  if (!entry) return null;
  return {
    startedAt: entry.startedAt,
    steps: entry.steps.map((s) => ({ text: s.text, status: s.status })),
    omitted: entry.omitted,
  };
}
