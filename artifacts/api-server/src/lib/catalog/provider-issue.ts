import type { ProviderSourceKeys } from "@workspace/db";

// Testo di issue (markdown, in italiano) per portare in Casello un provider non gestito, comparso nelle fonti
// del catalogo. Nomi, slug e id arrivano dalle fonti pubbliche: sempre su una riga e come codice (in linea o a blocchi).

const EXAMPLES = 5;

export interface IssueProvider {
  slug: string;
  name: string;
  sourceKeys: ProviderSourceKeys;
  firstSeenAt: Date;
}

const oneLine = (raw: string) => raw.replace(/\s+/g, " ").trim();

/** Su una sola riga e senza `#` iniziali. */
function cleanName(raw: string): string {
  return oneLine(raw).replace(/^[#\s]+/, "").trim() || "senza nome";
}

/**
 * Codice in linea con una recinzione più lunga di ogni serie di apici inversi contenuta: link, menzioni,
 * immagini e HTML arrivati dalle fonti restano testo letterale nell'issue incollata.
 */
function inlineCode(raw: string): string {
  const longest = Math.max(0, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = raw.startsWith("`") || raw.endsWith("`") ? " " : "";
  return `${fence}${pad}${raw}${pad}${fence}`;
}

/** Blocco di codice con una recinzione più lunga di ogni serie di apici inversi contenuta. */
function fenced(raw: string): string {
  const longest = Math.max(0, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${raw}\n${fence}`;
}

/**
 * Titolo e corpo dell'issue: nome, nomi nelle fonti, numero di voci (offerte), fino a 5 id di esempio
 * (nell'ordine dato) e cosa serve per gestirlo (protocollo, indirizzo, `source_keys` nel registro).
 */
export function providerIssue(p: IssueProvider, offerCount: number, exampleIds: string[]): { title: string; body: string } {
  const name = inlineCode(cleanName(p.name));
  const sourceNames = [
    ...p.sourceKeys.litellm.map((k) => `litellm_provider: ${oneLine(k)}`),
    ...(p.sourceKeys.openrouterAuthor ? [`autore OpenRouter: ${oneLine(p.sourceKeys.openrouterAuthor)}`] : []),
  ];
  const examples = exampleIds.slice(0, EXAMPLES).map(oneLine);
  const body = [
    "## Contesto",
    `L'aggiornamento del catalogo ha trovato il provider ${name} (slug ${inlineCode(oneLine(p.slug))}), ` +
      `comparso il ${p.firstSeenAt.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" })} ` +
      `con ${offerCount} voci nel catalogo. Oggi è non gestito: un account si può creare solo come compatibile OpenAI ` +
      "inserendo l'indirizzo a mano.",
    "Nomi nelle fonti:",
    fenced(sourceNames.length ? sourceNames.join("\n") : "nessuno"),
    "Id di esempio presso il provider:",
    examples.length ? fenced(examples.join("\n")) : "Nessun id di esempio.",
    "## Da fare",
    [
      "- Verificare il protocollo del provider (compatibile OpenAI, Anthropic, Bedrock, Vertex, Azure).",
      "- Indicare l'indirizzo predefinito delle API (o null se dipende dall'account o dall'ambiente).",
      "- Aggiungere la voce al registro in `artifacts/api-server/src/lib/catalog/provider-registry-data.ts` con lo slug, " +
        "il nome e le `source_keys` (i nomi nelle fonti qui sopra), così le offerte restano collegate.",
    ].join("\n"),
    "## Pronto quando",
    "All'avvio il provider risulta dal registro (`origin = registry`) con lo stato del suo protocollo e i suoi modelli " +
      "restano nel catalogo.",
  ].join("\n\n");
  return { title: `Gestire il provider ${name} in Casello`, body };
}
