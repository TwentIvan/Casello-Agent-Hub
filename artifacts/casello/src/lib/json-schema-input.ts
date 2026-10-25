import { z } from "zod";

/** Campo di testo con un oggetto JSON (lo schema dei parametri): facoltativo, ma se c'è deve essere valido. */
export const jsonObjectInput = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (!value) return;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Deve essere un oggetto JSON, es. { "type": "object" }.' });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON non valido: controlla virgolette doppie, virgole in più e parentesi.",
      });
    }
  });

/** Oggetto JSON del campo già validato, o null se vuoto/non valido (per leggerlo mentre si digita). */
export function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
