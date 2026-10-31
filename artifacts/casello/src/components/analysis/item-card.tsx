import { useState, type ReactNode } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { Check, Clock, Pencil, RotateCcw, X } from "lucide-react";
import {
  type AnalysisItem,
  type AnalysisItemUpdate,
  getGetAnalysisQueryKey,
  getGetAppPlanQueryKey,
  getGetDashboardStatsQueryKey,
  getGetDefaultModelQueryKey,
  getListAppToolsQueryKey,
  useGetDefaultModel,
  useUpdateAnalysisItem,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/components/ai/model-picker";
import { ItemEditDialog } from "@/components/analysis/item-edit-dialog";
import { IssueBadge } from "@/components/plan/issue-badge";
import {
  DIFF_LABELS,
  DIFF_STYLES,
  ITEM_STATUS_LABELS,
  ITEM_STATUS_STYLES,
  POSTPONABLE,
  bool,
  isRecord,
  itemArea,
  itemTitle,
  num,
  prettyJson,
  rec,
  str,
  strList,
} from "@/components/analysis/payload";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

const SOURCE_LABELS: Record<string, string> = {
  code: "Codice",
  openapi: "OpenAPI",
  description: "Descrizione",
};

const IDENTITY_LABELS: Record<string, string> = { user: "Utente", service: "Servizio" };

const EVOLUTION_TYPE_LABELS: Record<string, string> = {
  best_practice: "Buona pratica",
  funzione: "Funzione",
  integrazione: "Integrazione",
  agentica: "Agentica",
};

const yesNo = (value: boolean | undefined) => (value === undefined ? "—" : value ? "Sì" : "No");

// Le chiavi delle query degli agenti (elenco, dettaglio, skill) iniziano tutte con /api/agents.
const isAgentsQuery = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && head.startsWith("/api/agents");
};

// --- Blocchi di presentazione (solo testo semplice: niente HTML dal modello) ---

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Prose({ label, text }: { label: string; text: string | undefined }) {
  if (!text?.trim()) return null;
  return (
    <Field label={label}>
      <p className="whitespace-pre-wrap break-words">{text}</p>
    </Field>
  );
}

function Pre({ label, text }: { label: string; text: string | undefined }) {
  if (!text?.trim()) return null;
  return (
    <Field label={label}>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {text}
      </pre>
    </Field>
  );
}

function Names({ label, names, empty = "Nessuno" }: { label: string; names: string[]; empty?: string }) {
  return (
    <Field label={label}>
      {names.length === 0 ? (
        <span className="text-muted-foreground">{empty}</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {names.map((name) => (
            <Badge key={name} variant="outline" className="font-mono text-[11px] font-normal">
              {name}
            </Badge>
          ))}
        </span>
      )}
    </Field>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">{children}</dl>;
}

function RawPayload({ payload }: { payload: unknown }) {
  return <Pre label="Contenuto" text={prettyJson(payload)} />;
}

// --- Contenuto per capitolo ---

function ToolBody({ item }: { item: AnalysisItem }) {
  const p = item.payload;
  const definition = rec(p, "definition");
  const method = str(definition, "method");
  const path = str(definition, "path");
  const paramsSchema = rec(p, "paramsSchema");
  const locations = rec(definition, "paramLocations");
  return (
    <div className="space-y-3">
      {item.diff === "removed" && (
        <p className="text-sm text-muted-foreground">
          Il tool esiste nel catalogo ma l'architetto non l'ha riproposto: approvando viene disattivato (non eliminato).
        </p>
      )}
      <Prose label="Descrizione" text={str(p, "description")} />
      <Grid>
        <Field label="Chiamata">
          <span className="font-mono text-xs">{method && path ? `${method} ${path}` : "—"}</span>
        </Field>
        <Field label="Identità">{IDENTITY_LABELS[str(p, "identity") ?? ""] ?? "—"}</Field>
        <Field label="Chiede conferma">{yesNo(bool(p, "requiresConfirmation"))}</Field>
        <Field label="Sola lettura">{yesNo(bool(p, "readOnly"))}</Field>
      </Grid>
      {locations && Object.keys(locations).length > 0 && (
        <Field label="Posizione dei parametri">
          <span className="flex flex-wrap gap-1">
            {Object.entries(locations).map(([name, where]) => (
              <Badge key={name} variant="outline" className="font-mono text-[11px] font-normal">
                {name}: {typeof where === "string" ? where : "?"}
              </Badge>
            ))}
          </span>
        </Field>
      )}
      {paramsSchema && <Pre label="Schema dei parametri" text={prettyJson(paramsSchema)} />}
    </div>
  );
}

function EndpointBody({ item }: { item: AnalysisItem }) {
  const p = item.payload;
  return (
    <div className="space-y-3">
      <Field label="Endpoint">
        <span className="font-mono text-xs">
          {str(p, "method") ?? "?"} {str(p, "path") ?? "?"}
        </span>
      </Field>
      <Prose label="Motivazione" text={str(p, "motivation")} />
      <Pre label="Patch proposta" text={str(p, "patch")} />
    </div>
  );
}

function AgentBody({ item }: { item: AnalysisItem }) {
  const p = item.payload;
  return (
    <div className="space-y-3">
      <Grid>
        <Field label="Ruolo">{str(p, "role") === "general" ? "Generale" : "Di area"}</Field>
        <Field label="Identità predefinita">{IDENTITY_LABELS[str(p, "defaultIdentity") ?? ""] ?? "—"}</Field>
      </Grid>
      {str(p, "role") === "general" ? (
        <Field label="Tool">
          <span className="text-muted-foreground">L'agente generale usa tutti i tool attivi dell'app.</span>
        </Field>
      ) : (
        <Names label="Tool" names={strList(p, "toolNames")} />
      )}
      <Pre label="System prompt" text={str(p, "systemPrompt")} />
    </div>
  );
}

function SkillBody({ item }: { item: AnalysisItem }) {
  const p = item.payload;
  const paramsSchema = rec(p, "paramsSchema");
  return (
    <div className="space-y-3">
      <Prose label="Descrizione" text={str(p, "description")} />
      <Names label="Tool" names={strList(p, "toolNames")} />
      <Pre label="Istruzioni" text={str(p, "instructions")} />
      {paramsSchema && <Pre label="Schema dei parametri" text={prettyJson(paramsSchema)} />}
    </div>
  );
}

function CompletionBody({ item, dependsOnTitles }: { item: AnalysisItem; dependsOnTitles: string[] }) {
  const p = item.payload;
  const files = strList(p, "files");
  return (
    <div className="space-y-3">
      <Prose label="Obiettivo" text={str(p, "goal")} />
      <Prose label="Cosa manca" text={str(p, "missing")} />
      <Grid>
        <Field label="Fase">{num(p, "phase") ?? "—"}</Field>
        <Field label="Stima">{str(p, "effort") ?? "—"}</Field>
      </Grid>
      {dependsOnTitles.length > 0 && (
        <Field label="Dipende da">
          <ul className="list-inside list-disc">
            {dependsOnTitles.map((title, i) => (
              <li key={`${title}-${i}`}>{title}</li>
            ))}
          </ul>
        </Field>
      )}
      {files.length > 0 && (
        <Field label="File coinvolti">
          <ul className="space-y-0.5">
            {files.map((file) => (
              <li key={file} className="font-mono text-xs break-all">
                {file}
              </li>
            ))}
          </ul>
        </Field>
      )}
      <Prose label="Pronto quando" text={str(p, "doneWhen")} />
      <Pre label="Traccia di implementazione" text={str(p, "implementation")} />
    </div>
  );
}

function EvolutionBody({ item }: { item: AnalysisItem }) {
  const p = item.payload;
  const type = str(p, "type");
  return (
    <div className="space-y-3">
      <Grid>
        <Field label="Tipo">{type ? (EVOLUTION_TYPE_LABELS[type] ?? type) : "—"}</Field>
        <Field label="Priorità">{num(p, "priority") ?? "—"}</Field>
        <Field label="Impatto">{str(p, "impact") ?? "—"}</Field>
        <Field label="Stima">{str(p, "effort") ?? "—"}</Field>
      </Grid>
      <Prose label="Motivazione" text={str(p, "motivation")} />
      <Prose label="Beneficio" text={str(p, "benefit")} />
      <Pre label="Traccia di implementazione" text={str(p, "implementation")} />
    </div>
  );
}

/** Il payload ha la forma minima attesa per il capitolo? Altrimenti si mostra il JSON grezzo. */
function looksValid(item: AnalysisItem): boolean {
  const p = item.payload;
  if (!isRecord(p)) return false;
  switch (item.chapter) {
    case "tool":
    case "agent":
    case "skill":
      return str(p, "name") !== undefined;
    case "endpoint":
    case "completion":
    case "evolution":
      return str(p, "title") !== undefined;
    default:
      return false;
  }
}

function ItemBody({ item, dependsOnTitles }: { item: AnalysisItem; dependsOnTitles: string[] }) {
  if (!looksValid(item)) return <RawPayload payload={item.payload} />;
  switch (item.chapter) {
    case "tool":
      return <ToolBody item={item} />;
    case "endpoint":
      return <EndpointBody item={item} />;
    case "agent":
      return <AgentBody item={item} />;
    case "skill":
      return <SkillBody item={item} />;
    case "completion":
      return <CompletionBody item={item} dependsOnTitles={dependsOnTitles} />;
    case "evolution":
      return <EvolutionBody item={item} />;
    default:
      return <RawPayload payload={item.payload} />;
  }
}

function Evidence({ item }: { item: AnalysisItem }) {
  // Le prove stanno sia nell'elemento sia (per alcuni capitoli) nel payload: si usano quelle dell'elemento.
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  if (evidence.length === 0) return null;
  return (
    <Field label="Prove">
      <ul className="space-y-1">
        {evidence.map((e, i) => (
          <li key={i} className="text-xs">
            <span className="text-muted-foreground">{SOURCE_LABELS[e.source] ?? e.source}:</span>{" "}
            <span className="font-mono break-all">{e.location}</span>
            {e.note ? <span className="text-muted-foreground"> — {e.note}</span> : null}
          </li>
        ))}
      </ul>
    </Field>
  );
}

// --- Nota di revisione ---

function ReviewNote({
  item,
  pending,
  onSave,
}: {
  item: AnalysisItem;
  pending: boolean;
  onSave: (note: string | null) => void;
}) {
  const saved = item.reviewNote ?? "";
  const [note, setNote] = useState(saved);
  if (item.status === "approved") {
    return saved ? <Prose label="Nota di revisione" text={saved} /> : null;
  }
  const dirty = note.trim() !== saved.trim();
  return (
    <div className="space-y-2">
      <label htmlFor={`note-${item.id}`} className="text-xs font-medium text-muted-foreground">
        Nota di revisione
      </label>
      <Textarea
        id={`note-${item.id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Un appunto per te o per chi riprenderà la proposta…"
        className="text-sm"
      />
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setNote(saved)} disabled={pending}>
            Annulla
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onSave(note.trim() ? note.trim() : null)} disabled={pending}>
            Salva nota
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Scheda dell'elemento ---

interface ItemCardProps {
  item: AnalysisItem;
  appId: number;
  /** Solo completamento: titoli delle voci da cui dipende. */
  dependsOnTitles?: string[];
}

const SUCCESS_TITLES: Record<string, string> = {
  approved: "Elemento approvato",
  discarded: "Elemento scartato",
  postponed: "Elemento rimandato",
  pending: "Elemento ripristinato",
};

export function ItemCard({ item, appId, dependsOnTitles = [] }: ItemCardProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState(0);

  const review = useUpdateAnalysisItem({
    mutation: {
      onSuccess: (saved, { data }) => {
        void queryClient.invalidateQueries({ queryKey: getGetAnalysisQueryKey(item.analysisId) });
        void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) });
        if (saved.status === "approved") {
          // L'approvazione applica la proposta: catalogo, agenti e skill cambiano.
          void queryClient.invalidateQueries({ queryKey: getListAppToolsQueryKey(appId) });
          void queryClient.invalidateQueries({ predicate: isAgentsQuery });
          void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        }
        const title = data.status
          ? SUCCESS_TITLES[data.status]
          : data.payload !== undefined
            ? "Modifica salvata"
            : "Nota salvata";
        toast({ title, description: itemTitle(saved) });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Operazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  // Agente nuovo in attesa: si sceglie il modello (precompilato col predefinito), inviato con l'approvazione.
  // Un agente esistente mantiene il suo modello.
  const isNewAgent = item.chapter === "agent" && item.diff === "new" && item.status === "pending";
  const defaultModel = useGetDefaultModel({ query: { queryKey: getGetDefaultModelQueryKey(), enabled: isNewAgent } });
  const [chosenModel, setChosenModel] = useState<number | null | undefined>(undefined);
  const agentModelId = chosenModel !== undefined ? chosenModel : (defaultModel.data?.aiModelId ?? null);

  const send = (data: AnalysisItemUpdate, onDone?: () => void) => {
    const withModel = isNewAgent && data.status === "approved" && agentModelId !== null ? { ...data, aiModelId: agentModelId } : data;
    review.mutate({ id: item.id, data: withModel }, { onSuccess: () => onDone?.() });
  };

  const area = itemArea(item);
  const isTool = item.chapter === "tool";
  const needsVerification = isTool && bool(item.payload, "needsVerification") === true;
  const canPostpone = POSTPONABLE.has(item.chapter);
  // Il payload di un tool rimosso è la riga del catalogo: non è una proposta modificabile.
  const canEdit = item.diff !== "removed";
  const busy = review.isPending;

  return (
    <Card className={cn(item.status === "discarded" && "opacity-70")}>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <h4 className={cn("font-medium break-words", (isTool || item.chapter === "skill") && "font-mono text-sm")}>
              {itemTitle(item)}
            </h4>
            {area && <p className="text-xs text-muted-foreground">Area: {area}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn("border-transparent", DIFF_STYLES[item.diff])}>
              {DIFF_LABELS[item.diff]}
            </Badge>
            <Badge variant="outline" className={cn("border-transparent", ITEM_STATUS_STYLES[item.status])}>
              {ITEM_STATUS_LABELS[item.status]}
            </Badge>
            {item.issue && <IssueBadge issue={item.issue} />}
            {item.origin === "chat" && (
              <Badge variant="secondary" className="font-normal">
                da chat
              </Badge>
            )}
            {needsVerification && (
              <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Da verificare
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ItemBody item={item} dependsOnTitles={dependsOnTitles} />
        <Evidence item={item} />
        {isNewAgent && (
          <div className="max-w-md space-y-1">
            <Label htmlFor={`agent-model-${item.id}`} className="text-xs font-medium text-muted-foreground">
              Modello dell'agente
            </Label>
            <ModelPicker id={`agent-model-${item.id}`} value={agentModelId} onChange={setChosenModel} disabled={busy} />
            {agentModelId === null && (
              <p className="text-xs text-muted-foreground">Senza modello le run dell'agente non partono.</p>
            )}
          </div>
        )}
        <ReviewNote
          key={`${item.id}-${item.reviewNote ?? ""}`}
          item={item}
          pending={busy}
          onSave={(reviewNote) => send({ reviewNote })}
        />

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          {item.status === "approved" ? (
            <span className="text-xs text-muted-foreground">
              {item.appliedAt
                ? `Approvato il ${new Date(item.appliedAt).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}`
                : "Approvato"}
            </span>
          ) : item.status === "pending" ? (
            <>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditKey((k) => k + 1);
                    setEditOpen(true);
                  }}
                >
                  <Pencil />
                  Modifica
                </Button>
              )}
              {canPostpone && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => send({ status: "postponed" })}>
                  <Clock />
                  Rimanda
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => send({ status: "discarded" })}>
                <X />
                Scarta
              </Button>
              <Button size="sm" disabled={busy} onClick={() => send({ status: "approved" })}>
                <Check />
                {item.diff === "removed" ? "Approva (disattiva)" : "Approva"}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => send({ status: "pending" })}>
              <RotateCcw />
              Ripristina
            </Button>
          )}
        </div>
      </CardContent>

      {canEdit && item.status === "pending" && (
        <ItemEditDialog
          key={editKey}
          item={item}
          open={editOpen}
          onOpenChange={setEditOpen}
          pending={busy}
          onSubmit={(payload, approve) =>
            send(approve ? { payload, status: "approved" } : { payload }, () => setEditOpen(false))
          }
        />
      )}
    </Card>
  );
}
