import { useEffect, useRef, type ReactNode } from "react";
import type { CharacterPageContext, CharacterSubjectType } from "@workspace/api-client-react";
import { useAlfredAdapter, useLuciusSubjectAdapter } from "./character-adapters";
import { usePlanChatAdapter, useTeamChatAdapter } from "./plan-team-adapters";

// Un solo pannello (`CharacterChat`) per le conversazioni di Alfred e Lucius: ogni backend (conversazioni dei personaggi,
// chat del piano, chat di squadra) ha un adattatore che porta i suoi dati a una forma comune.

export const POLL_MS = 1500;
export const MAX_CHARS = 8000;

export type PageContext = CharacterPageContext;
export type SubjectType = CharacterSubjectType;
export type Character = "alfred" | "lucius";

/** Su cosa si apre il pannello. */
export type ChatTarget =
  | { kind: "alfred"; page: PageContext }
  | { kind: "character"; subjectType: Exclude<SubjectType, "alfred_thread">; subjectId: string | null; title: string }
  | { kind: "plan"; appId: number }
  | { kind: "team"; instanceId: number; closed: boolean };

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
  id: number;
  title: string;
  aiModelId: number | null;
  tokensUsed: number;
  costUsd: number | null;
  turnStatus: "idle" | "running";
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
  send(id: number, content: string): Promise<void>;
  /** Assente dove il backend non lo permette (chat di squadra): il modello si mostra senza poterlo cambiare. */
  setModel?(id: number, aiModelId: number): Promise<void>;
  decide(proposalId: number, decision: "accept" | "reject"): Promise<void>;
  /** Schede dei backend di oggi (piano e squadra); senza, le schede dei personaggi. */
  renderProposal?(p: ProposalLike, ctx: ProposalRenderContext): ReactNode;
  /** Testo quando la conversazione è vuota. */
  emptyHint: string;
  /** Cosa resta dopo l'eliminazione, per il dialogo di conferma. */
  deleteNote?: string;
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
  }
}

/** Chiave stabile del bersaglio: `CharacterChat` si rimonta quando cambia (gli adattatori usano hook diversi). */
export function targetKey(target: ChatTarget): string {
  switch (target.kind) {
    case "alfred":
      return "alfred";
    case "character":
      return `character:${target.subjectType}:${target.subjectId ?? ""}`;
    case "plan":
      return `plan:${target.appId}`;
    case "team":
      return `team:${target.instanceId}`;
  }
}

export function characterOf(target: ChatTarget): Character {
  return target.kind === "alfred" ? "alfred" : "lucius";
}

// --- Etichette e aiuti comuni ---------------------------------------------------------------------

export const SUBJECT_LABELS: Record<Exclude<SubjectType, "alfred_thread">, string> = {
  agent: "Agente",
  skill: "Skill",
  team_template: "Modello di squadra",
  area_agents: "Area Agenti",
  area_skills: "Area Skill",
  area_team_templates: "Area Modelli di squadra",
};

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
