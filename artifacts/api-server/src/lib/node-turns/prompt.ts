// Pacchetto del turno delegato (spec §3): i messaggi del turno, nel formato compatibile OpenAI, diventano il prompt di
// sistema e il prompt su stdin di `claude -p`. I messaggi di dati restano come sono, con i loro delimitatori `<dati>`.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** Riga aggiunta al prompt di sistema: gli strumenti arrivano dal server MCP `botcave` del turno. */
export const TOOLS_LINE = "Gli strumenti di Botcave si chiamano mcp__botcave__<nome>: usa solo quelli.";

const LABELS = { user: "[utente]", assistant: "[assistente]", tool: "[strumento]" } as const;

/** Testo di un messaggio: stringa, oppure le sue parti di testo una per riga. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: unknown) => (typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/**
 * `systemPrompt`: i messaggi `system` (e `developer`) più la riga sugli strumenti; `prompt`: gli altri messaggi in
 * ordine, ciascuno preceduto dalla sua etichetta, separati da una riga vuota. Messaggi senza testo saltati.
 */
export function toClaudePrompt(messages: ChatCompletionMessageParam[]): { systemPrompt: string; prompt: string } {
  const system: string[] = [];
  const parts: string[] = [];
  for (const m of messages) {
    const text = textOf(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text !== "") system.push(text);
      continue;
    }
    if (text === "") continue;
    const label = m.role === "user" || m.role === "assistant" ? LABELS[m.role] : LABELS.tool;
    parts.push(`${label}\n${text}`);
  }
  return { systemPrompt: [...system, TOOLS_LINE].join("\n"), prompt: parts.join("\n\n") };
}
