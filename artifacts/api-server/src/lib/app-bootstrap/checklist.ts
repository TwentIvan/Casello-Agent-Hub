import type { AppBootstrap } from "@workspace/db";
import { embedAllowedOrigins } from "../embed/origins";
import { appBaseDomain } from "./config";
import type { bootstrapNames } from "./naming";

export type BootstrapChecklistItem = {
  key: string;
  label: string;
  detail: string;
  auto: boolean;
  done: boolean;
  doneAt: string | null;
};

/** Chiavi delle voci segnabili a mano. */
export const MANUAL_ITEM_KEYS = ["dns", "neon", "coolify_api", "coolify_web", "secrets"] as const;

/** Lista guidata di ciò che l'utente fa fuori da Botcave: sette voci, due verificate da Botcave. */
export function buildChecklist(row: AppBootstrap, names: ReturnType<typeof bootstrapNames>): BootstrapChecklistItem[] {
  const manual = (key: string, label: string, detail: string): BootstrapChecklistItem => {
    const at = row.checklist[key]?.doneAt ?? null;
    return { key, label, detail, auto: false, done: at !== null, doneAt: at };
  };
  const inBase = row.domain.endsWith(`.${appBaseDomain()}`);
  const origin = `https://${row.domain}`;
  const originDone = embedAllowedOrigins().includes(origin);
  const healthAt = row.healthOkAt ? row.healthOkAt.toISOString() : null;
  return [
    manual(
      "dns",
      "Dominio",
      inBase
        ? `Il dominio ${row.domain} rientra nel dominio di base: controlla che il record DNS punti a Coolify.`
        : `Crea il record DNS di ${row.domain} verso Coolify: il dominio non rientra nel dominio di base ${appBaseDomain()}.`,
    ),
    manual("neon", "Database Neon", `Crea il progetto Neon «${row.slug}» e tieni la stringa di connessione diretta.`),
    manual(
      "coolify_api",
      "Servizio API su Coolify",
      `Crea il servizio ${names.apiService} dall'immagine ${names.apiImage}: porta 3000, rete interna, health check /api/healthz; variabili DATABASE_URL, PORT=3000, NODE_ENV=production, LOG_LEVEL=info, PUBLIC_APP_URL=${origin}.`,
    ),
    manual("coolify_web", "Servizio web su Coolify", `Crea il servizio ${names.webService} dall'immagine ${names.webImage} con il dominio ${row.domain}.`),
    manual(
      "secrets",
      "Segreti del repository",
      `Nel repository ${row.repo} aggiungi i segreti COOLIFY_TOKEN, COOLIFY_WEBHOOK_API e COOLIFY_WEBHOOK_WEB.`,
    ),
    {
      key: "embed_origin",
      label: "Origine del plugin",
      detail: `Aggiungi ${origin} a EMBED_ALLOWED_ORIGINS su casello-api e casello-web, poi rifai il deploy.`,
      auto: true,
      done: originDone,
      doneAt: null,
    },
    {
      key: "health",
      label: "App raggiungibile",
      detail: `Botcave controlla ${origin}/api/healthz.`,
      auto: true,
      done: healthAt !== null,
      doneAt: healthAt,
    },
  ];
}
