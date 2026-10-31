import { eq } from "drizzle-orm";
import { APIConnectionTimeoutError } from "openai";
import { db, aiModelsTable } from "@workspace/db";
import { ProviderError } from "./discovery";
import { modelChat, resolveModel } from "./executor";

// Una prova con 1 token non deve tenere la richiesta aperta per i 120 s di una chiamata normale
const PROBE_TIMEOUT_MS = 20_000;

/**
 * "Prova" di un modello: una chiamata reale con un messaggio minimo e `max_tokens: 1` (costo di
 * frazioni di centesimo, a carico dell'account). Solo per i modelli degli account dell'utente.
 * Aggiorna `last_probe_*` e, se riesce, `availability = 'available'`
 * (un 404 lo segna già `unavailable` modelChat).
 */
export async function probeModel(
  aiModelId: number,
  userId: number,
): Promise<{ ok: boolean; error: string | null; costUsd: number | null }> {
  let result: { ok: boolean; error: string | null; costUsd: number | null };
  try {
    // Un ProviderError di resolveModel (indirizzo non più consentito, chiave illeggibile) arriva solo
    // dopo il controllo del proprietario: è l'esito della prova
    const resolved = await resolveModel(aiModelId, { userId, mustOwn: true });
    const out = await modelChat(resolved, {
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
      maxRetries: 0,
      timeoutMs: PROBE_TIMEOUT_MS,
      caller: "probe",
    });
    result = { ok: true, error: null, costUsd: out.costUsd };
  } catch (err) {
    // Solo messaggi fissi: mai il testo del provider
    if (err instanceof ProviderError) result = { ok: false, error: err.message, costUsd: null };
    else if (err instanceof APIConnectionTimeoutError) result = { ok: false, error: new ProviderError("unreachable").message, costUsd: null };
    else throw err;
  }

  await db
    .update(aiModelsTable)
    .set({
      lastProbeAt: new Date(),
      lastProbeOk: result.ok,
      ...(result.ok ? { availability: "available" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(aiModelsTable.id, aiModelId));
  return result;
}
