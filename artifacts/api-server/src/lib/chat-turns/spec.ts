// Descrizione di una delle tre chat (conversazioni dei personaggi, chat del piano, chat di squadra) per la logica comune
// di «Ferma», «Invia subito» e «Accoda» (`control.ts`). Le tre tabelle dei messaggi hanno le stesse colonne usate qui
// (`id`, `conversation_id`, `role`, `content`, `error`, `queued_at`; `page_context` solo nei personaggi) e le tre
// tabelle delle conversazioni `id`, `turn_status`, `updated_at`: i nomi SQL bastano.

import type { ChatTurnKind } from "../stale-turns";
import type { NodeTurnConsumer } from "../node-turns/queue";
import type { PageContext } from "../characters/types";

export interface ChatKindSpec {
  kind: ChatTurnKind;
  consumer: NodeTurnConsumer;
  /** Nome SQL: "character_conversations" | "plan_conversations" | "team_chat_conversations". */
  conversationsTable: string;
  /** Nome SQL: "character_messages" | "plan_messages" | "team_chat_messages". */
  messagesTable: string;
  /** Solo `character_messages` ha `page_context`. */
  hasPageContext: boolean;
  /** Avvia un turno con il messaggio dell'utente (le stesse regole della route). */
  start(conversationId: number, content: string, page: PageContext | null): Promise<{ id: number }>;
}
