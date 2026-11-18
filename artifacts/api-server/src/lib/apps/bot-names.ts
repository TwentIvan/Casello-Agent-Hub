import type { App } from "@workspace/db";

// Nomi dei bot per App: Alfred, Lucius e il Responsabile si possono rinominare per ogni App.

export type BotNames = { alfred: string; lucius: string; lead: string };

export const BOT_NAME_DEFAULTS = { alfred: "Alfred", lucius: "Lucius", lead: "Responsabile" } as const;
/** Nome del Responsabile dell'App `casello` finché la colonna è vuota. */
export const CASELLO_LEAD_NAME = "Barbara";
export const BOT_NAME_ERROR = "nome del bot non valido";
const BOT_NAME_MAX = 40;

/** null = valido (o assente/null); altrimenti il messaggio fisso. Un nome è 1..40 caratteri visibili su una riga, senza `<` `>`. */
export function botNameError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return BOT_NAME_ERROR;
  const name = value.trim();
  if (name === "" || name.length > BOT_NAME_MAX) return BOT_NAME_ERROR;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(name)) return BOT_NAME_ERROR;
  return null;
}

export function resolveBotNames(app: Pick<App, "slug" | "alfredName" | "luciusName" | "leadName">): BotNames {
  return {
    alfred: app.alfredName ?? BOT_NAME_DEFAULTS.alfred,
    lucius: app.luciusName ?? BOT_NAME_DEFAULTS.lucius,
    lead: app.leadName ?? (app.slug === "casello" ? CASELLO_LEAD_NAME : BOT_NAME_DEFAULTS.lead),
  };
}
