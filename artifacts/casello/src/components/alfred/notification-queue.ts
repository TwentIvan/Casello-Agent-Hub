import type { AlfredNotification } from "@workspace/api-client-react";

// Coda delle novità di Alfred a voce (pura, senza React né rete): si consegnano solo nel silenzio.

export const NOTIFICATIONS_POLL_MS = 5_000;
export const SILENCE_AFTER_USER_MS = 2_000;

export interface SilenceState {
  modelSpeaking: boolean;
  toolRunning: boolean;
  lastUserSpeechAt: number | null;
  now: number;
}

export function notificationKey(e: AlfredNotification): string {
  return e.kind === "lead_run" ? `lead_run:${e.run}` : `queue_item:${e.numero}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const KIND_LABEL: Record<string, string> = { action: "azione", proposal: "proposta", plan: "piano", plan_change: "modifica del piano" };
const kindLabel = (tipo: string): string => KIND_LABEL[tipo] ?? tipo;

const RUN_STATUS: Record<string, string> = { succeeded: "finita", failed: "non riuscita", cancelled: "annullata" };

function formatEvent(e: AlfredNotification): string {
  if (e.kind === "lead_run") {
    const outcome = oneLine((e.status === "succeeded" ? e.output : e.error ?? e.output) ?? "");
    const items = e.items ?? [];
    const created = items.length > 0 ? ` Voci create: ${items.map((i) => `n. ${i.numero} (${kindLabel(i.tipo)}) ${oneLine(i.sintesi)}`).join("; ")}` : "";
    return `- Responsabile di ${oneLine(e.app ?? "app")}, run ${e.run}, ${RUN_STATUS[e.status ?? ""] ?? oneLine(e.status ?? "")}${outcome ? `: ${outcome}` : ""}.${created}`;
  }
  const team = e.squadra ? `, squadra ${oneLine(e.squadra)}` : "";
  return `- Nuova voce n. ${e.numero} (${kindLabel(e.tipo ?? "")})${team}: ${oneLine(e.sintesi ?? "")}.`;
}

export function formatNotifications(events: AlfredNotification[]): string {
  return ["[novità]", ...events.map(formatEvent)].join("\n");
}

export class NotificationQueue {
  private pending: AlfredNotification[] = [];
  private seen = new Set<string>();

  add(events: AlfredNotification[]): void {
    for (const e of events) {
      const key = notificationKey(e);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pending.push(e);
    }
  }

  takeMessage(state: SilenceState): string | null {
    if (this.pending.length === 0 || state.modelSpeaking || state.toolRunning) return null;
    if (state.lastUserSpeechAt !== null && state.now - state.lastUserSpeechAt < SILENCE_AFTER_USER_MS) return null;
    const text = formatNotifications(this.pending);
    this.pending = [];
    return text;
  }

  size(): number {
    return this.pending.length;
  }
}
