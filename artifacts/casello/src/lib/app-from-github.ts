// Nuova app da un repository GitHub (onboarding guidato, issue #111): valori proposti dal repository scelto.
import type { App, GithubRepo } from "@workspace/api-client-react";
import { DEFAULT_BASE_DOMAIN } from "./app-bootstrap";

/** Chiave stabile di un repository nell'elenco: lo stesso nome può comparire in più installazioni. */
export function repoKey(repo: Pick<GithubRepo, "installationId" | "fullName">): string {
  return `${repo.installationId}:${repo.fullName}`;
}

/** Nome proposto dal repository: `TwentIvan/the-hub-up` → «The Hub Up». */
export function appNameFromRepo(fullName: string): string {
  const repo = fullName.split("/").pop() ?? "";
  return repo
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Slug che il server darà all'app (stessa regola di `slugBase` in `api-server/src/lib/slug.ts`; se è già preso aggiunge `-<id>`). */
export function slugPreview(name: string): string {
  const slug = name
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

/** Base URL proposta: `https://<slug>.<dominio di base>`, da correggere se l'app sta altrove. */
export function suggestedBaseUrl(name: string, baseDomain: string = DEFAULT_BASE_DOMAIN): string {
  return `https://${slugPreview(name)}.${baseDomain}`;
}

/** Repository non ancora collegati a un'App (confronto senza distinguere le maiuscole), in ordine di nome. */
export function unregisteredRepos(repos: GithubRepo[], apps: Pick<App, "sourceRepo">[]): GithubRepo[] {
  const taken = new Set(apps.map((a) => a.sourceRepo?.toLowerCase()).filter((r): r is string => !!r));
  return repos
    .filter((r) => !taken.has(r.fullName.toLowerCase()))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
