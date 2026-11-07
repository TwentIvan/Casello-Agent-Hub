// Tipi, errori e messaggi condivisi di Alfred e Lucius nelle aree (motore delle conversazioni dei personaggi)

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { ChatToolCall } from "../ai/chat-types";
import type { Character } from "../memory/types";

export type { Character };

export const SUBJECT_TYPES = [
  "alfred_thread",
  "agent",
  "skill",
  "team_template",
  "area_agents",
  "area_skills",
  "area_team_templates",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const PROPOSAL_KINDS = [
  "agent_prompt",
  "agent_tools",
  "skill_content",
  "template_roles",
  "agent_create",
  "agent_trigger_create",
  "skill_create",
  "template_create",
  "decision",
  "handoff",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Pagina della console da cui l'utente scrive (solo sui messaggi dell'utente). */
export type PageContext = { page: string; id?: string; host?: HostContext };

/** Pagina dell'app ospite da cui scrive l'utente nel pannello incorporato (`page: "host"`). */
export type HostContext = { app: string; page: string; id?: string; title?: string };

/** Contesto di un turno passato agli strumenti dell'argomento. */
export interface TurnContext {
  userId: number;
  conversationId: number;
  /** Messaggio dell'assistente del turno corrente: le schede si legano a questo */
  messageId: number;
  subjectId: string | null;
  /** Schede che si possono ancora proporre in questo turno */
  proposalsLeft: () => number;
}

/** Argomento di una conversazione: un oggetto (agente, skill, modello di squadra), un'area o il filo di Alfred. */
export interface SubjectHandler {
  character: Character;
  type: SubjectType;
  /** Esiste ed è accessibile all'utente? Titolo da mostrare. null → 404 o «argomento eliminato». */
  resolve(userId: number, subjectId: string | null): Promise<{ title: string } | null>;
  /** Testi di dati per il contesto (ognuno diventa un messaggio `user` etichettato come dato): mai segreti né indirizzi delle app. */
  context(userId: number, subjectId: string | null, page: PageContext | null): Promise<string[]>;
  tools: ChatCompletionFunctionTool[];
  /** Restituisce sempre una stringa JSON `{ok: true, result}` o `{ok: false, error}`, mai eccezioni. */
  runTool(call: ChatToolCall, ctx: TurnContext): Promise<string>;
}

export const CHARACTER_MESSAGE_MAX_CHARS = 8_000;
export const MAX_PROPOSALS_PER_TURN = 10;
export const RATIONALE_MAX = 1_000;

export const CHARACTER_MESSAGES = {
  modelUnavailable: "modello non disponibile",
  notFound: "conversazione non trovata",
  subjectNotFound: "argomento non trovato",
  subjectGone: "argomento eliminato",
  busy: "il personaggio sta già rispondendo",
  empty: "messaggio vuoto",
  tooLong: `messaggio troppo lungo: al massimo ${CHARACTER_MESSAGE_MAX_CHARS} caratteri`,
  tooMany: "Troppe richieste: riprova tra poco",
  tooManyProposals: "troppe schede in questo turno",
  rationaleTooLong: `la motivazione supera ${RATIONALE_MAX} caratteri`,
  badPageContext: "contesto della pagina non valido",
  noModel: "Scegli un modello per la conversazione.",
  archived: "conversazione archiviata",
  threadKeep: "il filo di Alfred si ricomincia, non si elimina",
  proposalNotFound: "scheda non trovata",
  alreadyDecided: "scheda già decisa",
  invalidProposal: "scheda non valida",
  staleObject: "l'oggetto è cambiato: chiedi a Lucius una proposta aggiornata",
  staleItem: "la voce è cambiata: ricarica la coda",
  userTokenItem: "questa voce si approva dalla pagina Da confermare",
} as const;

// Errore con stato HTTP: le route lo traducono direttamente
export class CharacterError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CharacterError";
    this.status = status;
  }
}

/** Risultati degli strumenti in JSON, come nelle altre chat. */
export const toolOk = (result: unknown) => JSON.stringify({ ok: true, result });
export const toolFail = (error: string) => JSON.stringify({ ok: false, error });
