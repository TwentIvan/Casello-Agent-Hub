import type { AnalysisItem } from "@workspace/db";
import {
  ITEM_SCHEMAS,
  type AnalysisChapter,
  type CompletionItem,
  type EndpointProposal,
  type Evidence,
  type EvolutionItem,
} from "./schemas";

// Esportazione degli elementi approvati come testo di issue (markdown, in italiano).

/** Titolo su una sola riga e senza `#` iniziali: non può aprire un'intestazione o spezzare il testo. */
function cleanTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").replace(/^[#\s]+/, "").trim();
  return title || "Senza titolo";
}

/** Testo libero del modello: un `#` a inizio riga non deve diventare un'intestazione. */
function text(raw: string): string {
  return raw.replace(/^( {0,3})#/gm, "$1\\#");
}

/** Blocco di codice con una recinzione più lunga di ogni serie di apici inversi contenuta. */
function fenced(raw: string): string {
  const longest = Math.max(0, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${raw}\n${fence}`;
}

const oneLine = (raw: string) => raw.replace(/\s+/g, " ").trim();

function evidenceLines(evidence: Evidence[]): string {
  if (!evidence.length) return "Nessuna prova allegata.";
  return evidence
    .map((e) => `- ${e.source}: ${oneLine(e.location)}${e.note ? ` (${oneLine(e.note)})` : ""}`)
    .join("\n");
}

interface Sections {
  title: string;
  contesto: string;
  daFare: string;
  prontoQuando: string;
  prove: string;
}

function sectionsOf(item: AnalysisItem, depTitles: string[]): Sections {
  const parsed = ITEM_SCHEMAS[item.chapter].safeParse(item.payload);
  const data = (parsed.success ? parsed.data : item.payload) as Record<string, unknown>;
  const deps = depTitles.length ? `\n\nDipende da: ${depTitles.map(cleanTitle).join(", ")}` : "";

  if (parsed.success) {
    switch (item.chapter) {
      case "completion": {
        const c = data as unknown as CompletionItem;
        return {
          title: c.title,
          contesto: `Area: ${c.area}. Fase ${c.phase}, impegno ${c.effort}.\n\n${text(c.missing)}${deps}`,
          daFare: [text(c.goal), text(c.implementation), c.files.length ? `File coinvolti:\n${c.files.map((f) => `- ${oneLine(f)}`).join("\n")}` : ""]
            .filter(Boolean)
            .join("\n\n"),
          prontoQuando: text(c.doneWhen),
          prove: evidenceLines(c.evidence),
        };
      }
      case "endpoint": {
        const e = data as unknown as EndpointProposal;
        return {
          title: `Aggiungere l'endpoint ${e.method.toUpperCase()} ${e.path}`,
          contesto: `Area: ${e.area}.\n\n${text(e.motivation)}`,
          daFare: e.patch ? `Modifica proposta:\n\n${fenced(e.patch)}` : "Aggiungere l'endpoint descritto nel contesto.",
          prontoQuando: `L'endpoint ${e.method.toUpperCase()} ${e.path} risponde come descritto e l'app lo documenta nell'OpenAPI.`,
          prove: evidenceLines(e.evidence),
        };
      }
      case "evolution": {
        const e = data as unknown as EvolutionItem;
        return {
          title: e.title,
          contesto: `Area: ${e.area}. Tipo: ${e.type}, impatto ${e.impact}, impegno ${e.effort}, priorità ${e.priority}.\n\n${text(e.motivation)}`,
          daFare: text(e.implementation),
          prontoQuando: text(e.benefit),
          prove: evidenceLines(e.evidence),
        };
      }
      default:
        break;
    }
  }
  // Capitoli senza testo di issue dedicato (tool, agent, skill) o payload non valido
  const name = typeof data.title === "string" ? data.title : typeof data.name === "string" ? data.name : item.ref;
  return {
    title: name,
    contesto: `Elemento ${item.ref} (${item.chapter}).${deps}`,
    daFare: "Vedi la proposta dell'architetto.",
    prontoQuando: "La proposta è applicata e verificata.",
    prove: evidenceLines(Array.isArray(item.evidence) ? (item.evidence as Evidence[]) : []),
  };
}

function render(s: Sections, level: number): string {
  const h = "#".repeat(level);
  return [
    `${h} Contesto\n\n${s.contesto}`,
    `${h} Da fare\n\n${s.daFare}`,
    `${h} Pronto quando\n\n${s.prontoQuando}`,
    `${h} Prove\n\n${s.prove}`,
  ].join("\n\n");
}

/** Titolo e corpo di un'issue per un elemento; `depTitles` sono i titoli delle dipendenze (completion). */
export function issueMarkdown(item: AnalysisItem, depTitles: string[] = []): { title: string; body: string } {
  const s = sectionsOf(item, depTitles);
  return { title: cleanTitle(s.title), body: render(s, 2) };
}

/** Ordine topologico (le dipendenze prima), stabile; i cicli o i riferimenti ignoti non bloccano. */
function topoSort(items: AnalysisItem[], keyOf: (i: AnalysisItem) => string, depsOf: (i: AnalysisItem) => string[]) {
  const byKey = new Map(items.map((i) => [keyOf(i), i]));
  const done = new Set<AnalysisItem>();
  const out: AnalysisItem[] = [];
  const visiting = new Set<AnalysisItem>();
  const visit = (item: AnalysisItem) => {
    if (done.has(item) || visiting.has(item)) return; // già emessa, o ciclo: si interrompe
    visiting.add(item);
    for (const dep of depsOf(item)) {
      const target = byKey.get(dep);
      if (target) visit(target);
    }
    visiting.delete(item);
    done.add(item);
    out.push(item);
  };
  items.forEach(visit);
  return out;
}

function completionData(item: AnalysisItem): { key: string; phase: number; dependsOn: string[]; title: string } {
  const p = item.payload as Partial<CompletionItem> | null;
  return {
    key: typeof p?.key === "string" ? p.key : item.ref,
    phase: typeof p?.phase === "number" ? p.phase : 0,
    dependsOn: Array.isArray(p?.dependsOn) ? p.dependsOn.filter((d): d is string => typeof d === "string") : [],
    title: typeof p?.title === "string" ? p.title : item.ref,
  };
}

function evolutionData(item: AnalysisItem): { area: string; priority: number } {
  const p = item.payload as Partial<EvolutionItem> | null;
  return {
    area: typeof p?.area === "string" ? cleanTitle(p.area) : "Senza area",
    priority: typeof p?.priority === "number" ? p.priority : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Markdown unico con le issue del capitolo; `completion` per fase e in ordine di dipendenza,
 * `evolution` per area (nell'ordine in cui compaiono) e per priorità (1 = massima), poi posizione.
 */
export function exportIssues(items: AnalysisItem[], chapter: AnalysisChapter): { markdown: string; count: number } {
  const chosen = items.filter((i) => i.chapter === chapter);
  if (!chosen.length) return { markdown: "", count: 0 };

  const blocks: string[] = [];
  if (chapter === "completion") {
    const titles = new Map(chosen.map((i) => [completionData(i).key, completionData(i).title]));
    const phases = [...new Set(chosen.map((i) => completionData(i).phase))].sort((a, b) => a - b);
    for (const phase of phases) {
      const inPhase = chosen.filter((i) => completionData(i).phase === phase);
      blocks.push(`## Fase ${phase}`);
      for (const item of topoSort(inPhase, (i) => completionData(i).key, (i) => completionData(i).dependsOn)) {
        const depTitles = completionData(item).dependsOn.map((d) => titles.get(d) ?? d);
        const s = sectionsOf(item, depTitles);
        blocks.push(`### ${cleanTitle(s.title)}\n\n${render(s, 4)}`);
      }
    }
  } else if (chapter === "evolution") {
    const ordered = [...chosen].sort((a, b) => a.position - b.position);
    const areas = [...new Set(ordered.map((i) => evolutionData(i).area))];
    for (const area of areas) {
      blocks.push(`## ${area}`);
      const inArea = ordered
        .filter((i) => evolutionData(i).area === area)
        .sort((a, b) => evolutionData(a).priority - evolutionData(b).priority || a.position - b.position);
      for (const item of inArea) {
        const s = sectionsOf(item, []);
        blocks.push(`### ${cleanTitle(s.title)}\n\n${render(s, 4)}`);
      }
    }
  } else {
    for (const item of chosen) {
      const s = sectionsOf(item, []);
      blocks.push(`## ${cleanTitle(s.title)}\n\n${render(s, 3)}`);
    }
  }
  return { markdown: blocks.join("\n\n"), count: chosen.length };
}
