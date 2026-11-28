import { z } from "zod";
import { RoleKey } from "./manifest";

// Relazioni tra i ruoli di una squadra (spec 2026-11-28-botcave-relazioni-ruoli): una freccia `from → to` dice che il ruolo
// `from` può contattare il ruolo `to` durante un compito (`full`: consultazioni e messaggi; `notes`: solo messaggi). Il capo
// non entra nelle relazioni (raggiunge già tutti ed è raggiunto da tutti). Modulo puro: regole e piccole letture.

export const MAX_LINKS = 60;

export const LINK_MESSAGES = {
  invalid: "relazioni non valide",
  tooMany: "troppe relazioni",
  self: "una relazione non può collegare un ruolo a sé stesso",
  unknownRole: (key: string) => `relazione con un ruolo inesistente: ${key}`,
  lead: "il capo non entra nelle relazioni: raggiunge già tutti i ruoli",
  duplicate: "relazioni ripetute",
  nodeSender: "un ruolo sul nodo non può ancora contattare i colleghi",
  nodeTargetFull: "verso un ruolo sul nodo si possono mandare solo messaggi: scegli «solo messaggi»",
} as const;

export const RoleLinkSchema = z.object({
  from: z.string().regex(RoleKey),
  to: z.string().regex(RoleKey),
  mode: z.enum(["full", "notes"]),
});

export type RoleLink = z.infer<typeof RoleLinkSchema>;

type LinkRole = { key: string; isLead: boolean; runsOn: "cloud" | "node" };

/** Il primo errore delle relazioni rispetto ai ruoli dati (null se valide). */
export function linksError(roles: LinkRole[], links: unknown): string | null {
  const parsed = RoleLinkSchema.array().safeParse(links);
  if (!parsed.success) return LINK_MESSAGES.invalid;
  const list = parsed.data;
  if (list.length > MAX_LINKS) return LINK_MESSAGES.tooMany;
  const byKey = new Map(roles.map((r) => [r.key, r]));
  const seen = new Set<string>();
  for (const link of list) {
    if (link.from === link.to) return LINK_MESSAGES.self;
    const from = byKey.get(link.from);
    const to = byKey.get(link.to);
    if (!from) return LINK_MESSAGES.unknownRole(link.from);
    if (!to) return LINK_MESSAGES.unknownRole(link.to);
    if (from.isLead || to.isLead) return LINK_MESSAGES.lead;
    const id = `${link.from}\u0000${link.to}`;
    if (seen.has(id)) return LINK_MESSAGES.duplicate;
    seen.add(id);
    if (from.runsOn === "node") return LINK_MESSAGES.nodeSender;
    if (to.runsOn === "node" && link.mode === "full") return LINK_MESSAGES.nodeTargetFull;
  }
  return null;
}

/**
 * Toglie le relazioni non più valide per i ruoli dati (ruolo sparito, diventato capo o sul nodo come mittente) e riduce a
 * «solo messaggi» quelle verso un ruolo passato sul nodo. Serve quando cambiano i ruoli senza toccare le frecce.
 */
export function pruneLinks(roles: LinkRole[], links: RoleLink[]): RoleLink[] {
  const byKey = new Map(roles.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const out: RoleLink[] = [];
  for (const link of links) {
    const from = byKey.get(link.from);
    const to = byKey.get(link.to);
    if (!from || !to || link.from === link.to || from.isLead || to.isLead || from.runsOn === "node") continue;
    const id = `${link.from}\u0000${link.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(to.runsOn === "node" ? { ...link, mode: "notes" } : link);
  }
  return out.slice(0, MAX_LINKS);
}

/** Relazioni in uscita dal ruolo. */
export function outgoingLinks(links: RoleLink[], roleKey: string): RoleLink[] {
  return links.filter((l) => l.from === roleKey);
}

/** Legge le relazioni salvate (jsonb), scartando quelle malformate. */
export function readLinks(value: unknown): RoleLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = RoleLinkSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export const linkId = (link: Pick<RoleLink, "from" | "to">): string => `link:${link.from}:${link.to}`;
