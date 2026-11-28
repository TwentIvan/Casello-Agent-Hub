import type { TeamRoleLink } from "@workspace/api-client-react";

// Relazioni tra i ruoli nell'editor (modello e squadra): le frecce collegano i ruoli per `uid` (la chiave di un ruolo nuovo nasce
// solo al salvataggio) e si traducono in chiavi quando si salva. Stesse regole del server (`lib/teams/links.ts`).

export type LinkMode = TeamRoleLink["mode"];

export interface LinkDraft {
  from: string;
  to: string;
  mode: LinkMode;
}

/** Il minimo di un ruolo che serve alle regole. */
export interface LinkRole {
  uid: string;
  key: string;
  name: string;
  isLead: boolean;
  runsOn: "cloud" | "node";
}

export const MAX_LINKS = 60;

export const MODE_LABELS: Record<LinkMode, string> = {
  full: "Consultazioni e messaggi",
  notes: "Solo messaggi",
};

/** Perché la freccia `from → to` non si può tracciare (null se si può), senza contare le frecce già presenti. */
export function linkProblem(roles: LinkRole[], fromUid: string, toUid: string): string | null {
  const from = roles.find((r) => r.uid === fromUid);
  const to = roles.find((r) => r.uid === toUid);
  if (!from || !to) return "ruolo inesistente";
  if (from.uid === to.uid) return "una relazione non può collegare un ruolo a sé stesso";
  if (from.isLead || to.isLead) return "il capo non entra nelle relazioni: raggiunge già tutti i ruoli";
  if (from.runsOn === "node") return "un ruolo sul nodo non può ancora contattare i colleghi";
  return null;
}

/** Modalità ammessa per una freccia verso `to`: verso un ruolo sul nodo solo messaggi. */
export function allowedMode(roles: LinkRole[], toUid: string, wanted: LinkMode): LinkMode {
  return roles.find((r) => r.uid === toUid)?.runsOn === "node" ? "notes" : wanted;
}

const same = (a: Pick<LinkDraft, "from" | "to">, b: Pick<LinkDraft, "from" | "to">) => a.from === b.from && a.to === b.to;

/** Aggiunge (o sostituisce) una freccia; null se non è ammessa. */
export function addLink(roles: LinkRole[], links: LinkDraft[], link: LinkDraft): LinkDraft[] | null {
  if (linkProblem(roles, link.from, link.to)) return null;
  const next = { ...link, mode: allowedMode(roles, link.to, link.mode) };
  const exists = links.some((l) => same(l, next));
  if (!exists && links.length >= MAX_LINKS) return null;
  return exists ? links.map((l) => (same(l, next) ? next : l)) : [...links, next];
}

export function removeLink(links: LinkDraft[], link: Pick<LinkDraft, "from" | "to">): LinkDraft[] {
  return links.filter((l) => !same(l, link));
}

/** Inverte la freccia (se il verso opposto è ammesso; altrimenti invariato). */
export function reverseLink(roles: LinkRole[], links: LinkDraft[], link: LinkDraft): LinkDraft[] {
  if (linkProblem(roles, link.to, link.from)) return links;
  const without = removeLink(links, link).filter((l) => !(l.from === link.to && l.to === link.from));
  return [...without, { from: link.to, to: link.from, mode: allowedMode(roles, link.from, link.mode) }];
}

/** Aggiunge la freccia opposta (relazione doppia), se ammessa. */
export function makeDouble(roles: LinkRole[], links: LinkDraft[], link: LinkDraft): LinkDraft[] {
  return addLink(roles, links, { from: link.to, to: link.from, mode: link.mode }) ?? links;
}

export function hasReverse(links: LinkDraft[], link: Pick<LinkDraft, "from" | "to">): boolean {
  return links.some((l) => l.from === link.to && l.to === link.from);
}

/** Toglie le frecce non più valide per i ruoli attuali e riduce a «solo messaggi» quelle verso un ruolo sul nodo. */
export function pruneDraftLinks(roles: LinkRole[], links: LinkDraft[]): LinkDraft[] {
  const out: LinkDraft[] = [];
  for (const l of links) {
    if (linkProblem(roles, l.from, l.to)) continue;
    if (out.some((o) => same(o, l))) continue;
    out.push({ ...l, mode: allowedMode(roles, l.to, l.mode) });
  }
  return out.slice(0, MAX_LINKS);
}

/** Dalle relazioni salvate (chiavi) alle frecce dell'editor (uid). */
export function linksFromApi(roles: LinkRole[], links: TeamRoleLink[]): LinkDraft[] {
  const uidOf = new Map(roles.filter((r) => r.key).map((r) => [r.key, r.uid]));
  return links.flatMap((l) => {
    const from = uidOf.get(l.from);
    const to = uidOf.get(l.to);
    return from && to ? [{ from, to, mode: l.mode }] : [];
  });
}

/** Dalle frecce dell'editor alle relazioni da salvare: `roles` con le chiavi già assegnate (`withKeys`). */
export function linksToApi(roles: LinkRole[], links: LinkDraft[]): TeamRoleLink[] {
  const keyOf = new Map(roles.map((r) => [r.uid, r.key]));
  return pruneDraftLinks(roles, links).flatMap((l) => {
    const from = keyOf.get(l.from);
    const to = keyOf.get(l.to);
    return from && to ? [{ from, to, mode: l.mode }] : [];
  });
}
