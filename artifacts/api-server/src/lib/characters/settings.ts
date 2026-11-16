import { and, asc, eq } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, usersTable } from "@workspace/db";
import { checkUrl } from "../web-reader/fetch-page";
import { isAudioOnlyModel } from "../ai/model-status";
import { budgetColumn, characterSpend } from "../budget";
import { getDefaultModel, ownModel } from "../ai/default-model";
import type { Character } from "../memory/types";
import { CHARACTER_MESSAGES, CharacterError } from "./types";

export interface CharacterSettings {
  alfredChatAiModelId: number | null;
  luciusAiModelId: number | null;
  alfredMonthlyBudgetUsd: number | null;
  luciusMonthlyBudgetUsd: number | null;
  /** Best practice di Lucius: «always» = interruttore acceso alla creazione di ogni conversazione. */
  luciusBestPractice?: BestPracticeMode;
  /** Modello Gemini che fa la ricerca (null = nessuno). */
  luciusSearchAiModelId?: number | null;
  luciusSources?: LuciusSource[];
}

export type BestPracticeMode = "always" | "on_request";
export interface LuciusSource {
  url: string;
  label: string;
}

const MAX_SOURCES = 30;
const SEARCH_MODEL_INVALID = "modello di ricerca non valido: scegli un modello Gemini dei tuoi account";
const sourcesInvalid = (why: string) => new CharacterError(400, `fonti curate non valide: ${why}`);

/** Impostazioni più la spesa del mese di ciascun personaggio (`characterSpend`) e le esecuzioni senza prezzo. */
export interface CharacterSettingsView extends CharacterSettings {
  alfredSpentUsd: number;
  luciusSpentUsd: number;
  alfredUnpricedCount: number;
  luciusUnpricedCount: number;
  luciusBestPractice: BestPracticeMode;
  luciusSearchAiModelId: number | null;
  luciusSources: LuciusSource[];
  searchModels: { id: number; name: string; accountName: string }[];
}

const num = (v: string | null) => (v === null ? null : Number(v));

type FullSettings = Required<CharacterSettings>;

export async function getCharacterSettings(userId: number): Promise<FullSettings> {
  const [row] = await db
    .select({
      alfredChatAiModelId: usersTable.alfredChatAiModelId,
      luciusAiModelId: usersTable.luciusAiModelId,
      alfredMonthlyBudgetUsd: usersTable.alfredMonthlyBudgetUsd,
      luciusMonthlyBudgetUsd: usersTable.luciusMonthlyBudgetUsd,
      luciusBestPractice: usersTable.luciusBestPractice,
      luciusSearchAiModelId: usersTable.luciusSearchAiModelId,
      luciusSources: usersTable.luciusSources,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return {
    alfredChatAiModelId: row?.alfredChatAiModelId ?? null,
    luciusAiModelId: row?.luciusAiModelId ?? null,
    alfredMonthlyBudgetUsd: num(row?.alfredMonthlyBudgetUsd ?? null),
    luciusMonthlyBudgetUsd: num(row?.luciusMonthlyBudgetUsd ?? null),
    luciusBestPractice: row?.luciusBestPractice ?? "on_request",
    luciusSearchAiModelId: row?.luciusSearchAiModelId ?? null,
    luciusSources: row?.luciusSources ?? [],
  };
}

/** Vero se l'utente vuole le best practice accese in ogni nuova conversazione di Lucius. */
export async function luciusBestPracticeDefault(userId: number): Promise<boolean> {
  return (await getCharacterSettings(userId)).luciusBestPractice === "always";
}

/** Modelli Gemini dei propri account, esclusi quelli solo audio/live: quelli ammessi per la ricerca. */
async function listSearchModels(userId: number): Promise<CharacterSettingsView["searchModels"]> {
  const rows = await db
    .select({ id: aiModelsTable.id, modelId: aiModelsTable.modelId, displayName: aiModelsTable.displayName, accountName: aiAccountsTable.name })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(and(eq(aiAccountsTable.userId, userId), eq(aiAccountsTable.provider, "gemini")))
    .orderBy(asc(aiAccountsTable.name), asc(aiModelsTable.modelId));
  return rows
    .filter((r) => !isAudioOnlyModel(r.modelId))
    .map((r) => ({ id: r.id, name: r.displayName || r.modelId, accountName: r.accountName }));
}

/** Controlla le fonti curate e le restituisce ripulite (indirizzo senza frammento); altrimenti 400 «fonti curate non valide: …». */
function cleanSources(sources: LuciusSource[]): LuciusSource[] {
  if (sources.length > MAX_SOURCES) throw sourcesInvalid(`al massimo ${MAX_SOURCES}`);
  const seen = new Set<string>();
  return sources.map((s) => {
    const label = typeof s.label === "string" ? s.label.trim() : "";
    if (label.length < 1 || label.length > 80 || /[\r\n]/.test(label)) throw sourcesInvalid("l'etichetta va da 1 a 80 caratteri su una riga");
    const checked = checkUrl(s.url);
    if (!checked.ok) throw sourcesInvalid(`indirizzo non valido (${s.url.slice(0, 80)}): serve un https pubblico`);
    const url = checked.url.toString();
    if (seen.has(url)) throw sourcesInvalid(`indirizzo ripetuto (${url.slice(0, 80)})`);
    seen.add(url);
    return { url, label };
  });
}

export async function getCharacterSettingsView(userId: number): Promise<CharacterSettingsView> {
  const [settings, alfred, lucius] = await Promise.all([
    getCharacterSettings(userId),
    characterSpend(userId, "alfred"),
    characterSpend(userId, "lucius"),
  ]);
  return {
    ...settings,
    alfredSpentUsd: alfred.spentUsd,
    luciusSpentUsd: lucius.spentUsd,
    alfredUnpricedCount: alfred.unpricedCount,
    luciusUnpricedCount: lucius.unpricedCount,
    searchModels: await listSearchModels(userId),
  };
}

/** Salva i campi presenti nel patch; un modello che non è di un proprio account → 400 «modello non disponibile». */
export async function setCharacterSettings(userId: number, patch: Partial<CharacterSettings>): Promise<void> {
  for (const id of [patch.alfredChatAiModelId, patch.luciusAiModelId]) {
    if (id == null) continue;
    if (!Number.isSafeInteger(id) || id <= 0 || !(await ownModel(userId, id, db))) {
      throw new CharacterError(400, CHARACTER_MESSAGES.modelUnavailable);
    }
  }
  let sources: LuciusSource[] | undefined;
  if (patch.luciusSources !== undefined) sources = cleanSources(patch.luciusSources);
  if (patch.luciusSearchAiModelId != null) {
    const ok = (await listSearchModels(userId)).some((m) => m.id === patch.luciusSearchAiModelId);
    if (!ok) throw new CharacterError(400, SEARCH_MODEL_INVALID);
  }
  const set: Partial<typeof usersTable.$inferInsert> = {};
  if (patch.luciusBestPractice !== undefined) set.luciusBestPractice = patch.luciusBestPractice;
  if (patch.luciusSearchAiModelId !== undefined) set.luciusSearchAiModelId = patch.luciusSearchAiModelId;
  if (sources !== undefined) set.luciusSources = sources;
  if (patch.alfredChatAiModelId !== undefined) set.alfredChatAiModelId = patch.alfredChatAiModelId;
  if (patch.luciusAiModelId !== undefined) set.luciusAiModelId = patch.luciusAiModelId;
  if (patch.alfredMonthlyBudgetUsd !== undefined) set.alfredMonthlyBudgetUsd = budgetColumn(patch.alfredMonthlyBudgetUsd);
  if (patch.luciusMonthlyBudgetUsd !== undefined) set.luciusMonthlyBudgetUsd = budgetColumn(patch.luciusMonthlyBudgetUsd);
  if (Object.keys(set).length === 0) return;
  await db.update(usersTable).set(set).where(eq(usersTable.id, userId));
}

/** Modello del personaggio se ancora di un account dell'utente, altrimenti il predefinito (se ancora suo), altrimenti null. */
export async function characterModelFor(userId: number, character: Character): Promise<number | null> {
  const s = await getCharacterSettings(userId);
  const own = character === "alfred" ? s.alfredChatAiModelId : s.luciusAiModelId;
  for (const id of [own, await getDefaultModel(userId)]) {
    if (id !== null && (await ownModel(userId, id, db))) return id;
  }
  return null;
}
