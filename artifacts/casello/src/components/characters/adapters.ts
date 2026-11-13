import { useEffect, useRef, type ReactNode } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { CharacterPageContext, CharacterSubjectType, TurnProgress } from "@workspace/api-client-react";
import { useAlfredAdapter, useLuciusSubjectAdapter } from "./character-adapters";
import { SUBJECT_LABELS, targetKey } from "./targets";
import { useLeadChatAdapter } from "./lead-adapter";
import { usePlanChatAdapter, useTeamChatAdapter } from "./plan-team-adapters";
import type { SendMode } from "./chat-send";

// Un solo pannello (`CharacterChat`) per le conversazioni di Alfred e Lucius: ogni backend (conversazioni dei personaggi,
// chat del piano, chat di squadra) ha un adattatore che porta i suoi dati a una forma comune.

export const POLL_MS = 1500;
export const MAX_CHARS = 8000;

/** Si rilegge la conversazione finché il turno è in corso o c'è un messaggio in coda (può far ripartire subito un turno). */
export function chatPollInterval(data: { turnStatus: string; queuedMessage?: unknown } | undefined): number | false {
  return data?.turnStatus === "running" || (data?.queuedMessage ?? null) !== null ? POLL_MS : false;
}

// Funzioni pure spostate in `targets.ts` (provabili con Vitest senza React)
export { SUBJECT_LABELS, targetKey };

export type PageContext = CharacterPageContext;
export type SubjectType = CharacterSubjectType;
export type Character = "alfred" | "lucius" | "responsabile";

/** Su cosa si apre il pannello. */
export type ChatTarget =
  | { kind: "alfred"; page: PageContext }
  | { kind: "character"; subjectType: Exclude<SubjectType, "alfred_thread">; subjectId: string | null; title: string }
  | { kind: "plan"; appId: number }
  | { kind: "team"; instanceId: number; closed: boolean }
  /** Chat con il Responsabile di Botcave (solo console): `page` è la pagina da cui si scrive. */
  | { kind: "lead"; page: { page: string; id?: string } };

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

export interface ConvSummary {
  id: number;
  title: string;
  updatedAt: string;
  tokensUsed: number;
  costUsd: number | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  error: boolean;
}

/** Scheda in forma comune; `raw` è l'oggetto originale del backend (per `renderProposal`). */
export interface ProposalLike {
  id: number;
  messageId: number;
  kind: string;
  status: ProposalStatus;
  payload: Record<string, unknown> | null;
  rationale: string;
  raw: unknown;
}

export interface ConvDetail {
  /** Passi del turno in corso (null se il server non li riporta). */
  progress: TurnProgress | null;
  id: number;
  title: string;
  aiModelId: number | null;
  tokensUsed: number;
  costUsd: number | null;
  turnStatus: "idle" | "running";
  /** Messaggio in coda: parte da solo a fine turno (null = nessuno). */
  queuedMessage: { id: number; content: string } | null;
  /** Motivo della sola lettura (archiviata, argomento eliminato, squadra chiusa), null = si scrive. */
  readOnlyReason: string | null;
  /** Oggetto della conversazione (solo conversazioni dei personaggi), per le anteprime delle schede. */
  subjectId: string | null;
  messages: ChatMessage[];
  proposals: ProposalLike[];
  /** Avviso da mostrare sopra i messaggi (es. piano più recente). */
  notice?: ReactNode;
}

/** Quello che `CharacterChat` passa a `renderProposal`: la decisione passa sempre dal pannello (avviso modifiche non salvate). */
export interface ProposalRenderContext {
  deciding: boolean;
  readOnly: boolean;
  decide(decision: "accept" | "reject"): void;
}

export interface ChatAdapter {
  character: Character;
  /** «Agente · Supporto clienti», «Area Skill», «Il filo di Alfred» */
  subjectLabel: string;
  /** null = filo unico (Alfred) */
  useConversations(): { items: ConvSummary[]; isLoading: boolean; error?: unknown } | null;
  useConversation(id: number | null): { data?: ConvDetail; isLoading: boolean; error?: unknown };
  create(modelId: number | null): Promise<number>;
  remove?(id: number): Promise<void>;
  /** Solo Alfred: archivia il filo e ne apre uno nuovo. */
  restart?(): Promise<number>;
  /** `now` durante un turno: il testo va in coda e il turno si ferma; `queue`: parte a fine turno. */
  send(id: number, content: string, mode?: SendMode): Promise<void>;
  /** Ferma il turno in corso. Assente dove il backend non ha «Ferma» né la coda (Responsabile di Botcave). */
  stop?(id: number): Promise<void>;
  /** Toglie il messaggio in coda. Assente insieme a `stop`. */
  cancelQueued?(id: number): Promise<void>;
  /** Assente dove il backend non lo permette (chat di squadra): il modello si mostra senza poterlo cambiare. */
  setModel?(id: number, aiModelId: number): Promise<void>;
  decide(proposalId: number, decision: "accept" | "reject"): Promise<void>;
  /** Schede dei backend di oggi (piano e squadra); senza, le schede dei personaggi. */
  renderProposal?(p: ProposalLike, ctx: ProposalRenderContext): ReactNode;
  /** Testo quando la conversazione è vuota. */
  emptyHint: string;
  /** Cosa resta dopo l'eliminazione, per il dialogo di conferma. */
  deleteNote?: string;
  /** Lunghezza massima di un messaggio (default `MAX_CHARS`). */
  maxChars?: number;
  /** «Nuova» crea subito la conversazione, senza il dialogo del modello (Responsabile: il modello è dell'agente). */
  createWithoutDialog?: boolean;
  /** Argomento in sola lettura per intero (squadra chiusa): niente conversazioni nuove né messaggi. */
  closedReason?: string | null;
}

/** Adattatore del pannello per il bersaglio. Il tipo del bersaglio non deve cambiare per lo stesso componente montato. */
export function useCharacterAdapter(target: ChatTarget): ChatAdapter {
  switch (target.kind) {
    case "alfred":
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useAlfredAdapter(target.page);
    case "character":
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useLuciusSubjectAdapter(target);
    case "plan":
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return usePlanChatAdapter(target.appId);
    case "team":
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useTeamChatAdapter(target.instanceId, target.closed);
    case "lead":
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useLeadChatAdapter(target.page);
  }
}

/** Chiave stabile del bersaglio: `CharacterChat` si rimonta quando cambia (gli adattatori usano hook diversi). */
export function characterOf(target: ChatTarget): Character {
  if (target.kind === "lead") return "responsabile";
  return target.kind === "alfred" ? "alfred" : "lucius";
}

// --- Etichette e aiuti comuni ---------------------------------------------------------------------


/**
 * Dopo un'eliminazione riuscita: il dettaglio esce dalla cache e la conversazione dall'elenco, prima di rileggerlo,
 * così il pannello non chiede (e non mostra in errore 404) la conversazione appena eliminata.
 */
export function forgetConversation(queryClient: QueryClient, listKey: QueryKey, detailKey: QueryKey, id: number) {
  queryClient.setQueryData<{ id: number }[]>(listKey, (old) => old?.filter((c) => c.id !== id));
  queryClient.removeQueries({ queryKey: detailKey, exact: true });
}

/** A fine turno cambiano titolo e costo: si rileggono gli elenchi. */
export function useInvalidateOnTurnEnd(running: boolean, invalidate: () => void) {
  const wasRunning = useRef(false);
  const latest = useRef(invalidate);
  latest.current = invalidate;
  useEffect(() => {
    if (wasRunning.current && !running) latest.current();
    wasRunning.current = running;
  }, [running]);
}
