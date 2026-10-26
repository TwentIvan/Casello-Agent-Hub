import type { ProviderSourceKeys } from "@workspace/db";

// Testo di issue (markdown, in italiano) per portare in Casello un provider non gestito, comparso nelle fonti
// del catalogo. Nomi e id arrivano dalle fonti pubbliche: titolo su una riga, dati in blocchi di codice.

const EXAMPLES = 5;

export interface IssueProvider {
  slug: string;
  name: string;
  sourceKeys: ProviderSourceKeys;
  firstSeenAt: Date;
}

const oneLine = (raw: string) => raw.replace(/\s+/g, " ").trim();

/** Titolo su una sola riga e senza `#` iniziali: non può aprire un'intestazione o spezzare il testo. */
function cleanName(raw: string): string {
  return oneLine(raw).replace(/^[#\s]+/, "").trim() || "senza nome";
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
  const name = cleanName(p.name);
  const sourceNames = [
    ...p.sourceKeys.litellm.map((k) => `litellm_provider: ${oneLine(k)}`),
    ...(p.sourceKeys.openrouterAuthor ? [`autore OpenRouter: ${oneLine(p.sourceKeys.openrouterAuthor)}`] : []),
  ];
  const examples = exampleIds.slice(0, EXAMPLES).map(oneLine);
  const body = [
    "## Contesto",
    `L'aggiornamento del catalogo ha trovato il provider ${name} (slug \`${oneLine(p.slug)}\`), ` +
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
