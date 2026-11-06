// Registro degli argomenti delle conversazioni dei personaggi: un gestore per `subject_type`.
// Gli argomenti veri si registrano qui (Task 5 e 6); i test possono registrarne di finti con `registerSubject`.

import { CHARACTER_MESSAGES, CharacterError, type Character, type SubjectHandler, type SubjectType } from "./types";

const handlers = new Map<SubjectType, SubjectHandler>();

/** Registra (o sostituisce) il gestore di un argomento; restituisce la funzione che ripristina il precedente. */
export function registerSubject(handler: SubjectHandler): () => void {
  const previous = handlers.get(handler.type);
  handlers.set(handler.type, handler);
  return () => {
    if (previous) handlers.set(handler.type, previous);
    else handlers.delete(handler.type);
  };
}

export function unregisterSubject(type: SubjectType): void {
  handlers.delete(type);
}

/** Gestore dell'argomento; sconosciuto → `CharacterError` 404 «argomento non trovato». */
export function getSubject(type: SubjectType): SubjectHandler {
  const handler = handlers.get(type);
  if (!handler) throw new CharacterError(404, CHARACTER_MESSAGES.subjectNotFound);
  return handler;
}

export function findSubject(type: string): SubjectHandler | null {
  return handlers.get(type as SubjectType) ?? null;
}

export function subjectsOf(character: Character): SubjectHandler[] {
  return [...handlers.values()].filter((h) => h.character === character);
}
