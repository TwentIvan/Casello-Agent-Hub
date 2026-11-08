import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AppTool,
  type Trigger,
  type TriggerInput,
  type TriggerPatch,
  type TriggerTestResult,
  getListAgentTriggersQueryKey,
  useCreateAgentTrigger,
  useTestAgentTriggerConfig,
  useUpdateTrigger,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { TriggerTestTable } from "./trigger-test-table";

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 1440;
const DEFAULT_INTERVAL_MINUTES = 5;

/** Tool che un innesco di sorveglianza può chiamare: stessa app, attivo, http/mcp, solo lettura (L0), identità di servizio. */
export function eligibleTriggerTools(agent: Agent, tools: AppTool[]): AppTool[] {
  return tools
    .filter(
      (tool) =>
        tool.appId === agent.appId &&
        tool.status === "active" &&
        (tool.kind === "http" || tool.kind === "mcp") &&
        (tool.levelOverride ?? tool.level) === "L0" &&
        tool.identity === "service",
    )
    .sort((a, b) => a.name.localeCompare(b.name, "it"));
}

interface FormState {
  kind: "poll" | "webhook";
  name: string;
  instructions: string;
  toolId: string;
  args: string;
  itemsPath: string;
  idField: string;
  versionField: string;
  cursorParam: string;
  cursorField: string;
  filterField: string;
  filterEquals: string;
  minutes: string;
  dedupHeader: string;
}

function emptyForm(kind: "poll" | "webhook"): FormState {
  return {
    kind,
    name: "",
    instructions: "",
    toolId: "",
    args: "",
    itemsPath: "",
    idField: "",
    versionField: "",
    cursorParam: "",
    cursorField: "",
    filterField: "",
    filterEquals: "",
    minutes: String(DEFAULT_INTERVAL_MINUTES),
    dedupHeader: "",
  };
}

function formFromTrigger(trigger: Trigger): FormState {
  return {
    kind: trigger.kind,
    name: trigger.name,
    instructions: trigger.instructions ?? "",
    toolId: trigger.toolId !== null ? String(trigger.toolId) : "",
    args: Object.keys(trigger.args).length > 0 ? JSON.stringify(trigger.args, null, 2) : "",
    itemsPath: trigger.itemsPath ?? "",
    idField: trigger.idField ?? "",
    versionField: trigger.versionField ?? "",
    cursorParam: trigger.cursorParam ?? "",
    cursorField: trigger.cursorField ?? "",
    filterField: trigger.filter?.field ?? "",
    filterEquals: trigger.filter ? JSON.stringify(trigger.filter.equals) : "",
    minutes: trigger.intervalSeconds !== null ? String(Math.round(trigger.intervalSeconds / 60)) : String(DEFAULT_INTERVAL_MINUTES),
    dedupHeader: trigger.dedupHeader ?? "",
  };
}

/** Valore del filtro: true, false, numero o testo; tra virgolette per forzare il testo. */
function parseEquals(raw: string): string | number | boolean {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // resta testo semplice
    }
  }
  return text;
}

const blankToNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

type Built = { ok: true; value: TriggerInput } | { ok: false; error: string };

/** Corpo comune a creazione, prova e modifica: i campi vuoti sono null (nel PATCH vuol dire «tolto»). */
function buildInput(form: FormState): Built {
  const name = form.name.trim();
  if (name === "" || name.length > 80) return { ok: false, error: "Il nome va da 1 a 80 caratteri." };
  if (form.instructions.length > 2000) return { ok: false, error: "Le istruzioni sono al massimo 2000 caratteri." };
  const base = { kind: form.kind, name, instructions: blankToNull(form.instructions), idField: blankToNull(form.idField) };
  if (form.kind === "webhook") {
    return { ok: true, value: { ...base, dedupHeader: blankToNull(form.dedupHeader) } };
  }
  if (form.toolId === "") return { ok: false, error: "Scegli il tool da interrogare." };
  let args: Record<string, unknown> | null = null;
  if (form.args.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(form.args);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: "Gli argomenti devono essere un oggetto JSON valido." };
    }
  }
  const minutes = Number(form.minutes);
  if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    return { ok: false, error: `L'intervallo va da ${MIN_INTERVAL_MINUTES} a ${MAX_INTERVAL_MINUTES} minuti.` };
  }
  if (blankToNull(form.idField) === null) return { ok: false, error: "Indica il campo id degli elementi." };
  const filterField = form.filterField.trim();
  if (filterField !== "" && form.filterEquals.trim() === "") return { ok: false, error: "Il filtro vuole un valore." };
  return {
    ok: true,
    value: {
      ...base,
      toolId: Number(form.toolId),
      args,
      itemsPath: blankToNull(form.itemsPath),
      versionField: blankToNull(form.versionField),
      cursorParam: blankToNull(form.cursorParam),
      cursorField: blankToNull(form.cursorField),
      filter: filterField === "" ? null : { field: filterField, equals: parseEquals(form.filterEquals) },
      intervalSeconds: minutes * 60,
    },
  };
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  mono,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} placeholder={placeholder} className={mono ? "font-mono text-sm" : undefined} onChange={(event) => onChange(event.target.value)} />
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Dialogo «Nuovo innesco» / «Modifica» (il tipo non cambia dopo la creazione). */
export function TriggerDialog({
  open,
  onOpenChange,
  agent,
  tools,
  trigger,
  onWebhookCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  tools: AppTool[];
  /** Presente = modifica */
  trigger: Trigger | null;
  onWebhookCreated: (url: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() => emptyForm("poll"));
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TriggerTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(trigger ? formFromTrigger(trigger) : emptyForm("poll"));
    setFormError(null);
    setTestResult(null);
    setTestError(null);
  }, [open, trigger]);

  const set = <K extends keyof FormState>(key: K) => (value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Una prova vale per la configurazione con cui è stata fatta
    setTestResult(null);
    setTestError(null);
  };

  const usable = useMemo(() => eligibleTriggerTools(agent, tools), [agent, tools]);
  // Un tool già scelto che non è più idoneo resta visibile (il server rifiuterà se non lo si cambia)
  const chosen = tools.find((tool) => String(tool.id) === form.toolId);
  const toolOptions = chosen && !usable.some((tool) => tool.id === chosen.id) ? [chosen, ...usable] : usable;

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListAgentTriggersQueryKey(agent.id) });
  const onError = (title: string) => (error: unknown) => toast({ variant: "destructive", title, description: apiErrorMessage(error) });

  const create = useCreateAgentTrigger({
    mutation: {
      onSuccess: (created) => {
        void refresh();
        toast({ title: "Innesco creato in pausa" });
        onOpenChange(false);
        if (created.webhookUrl) onWebhookCreated(created.webhookUrl);
      },
      onError: onError("Creazione non riuscita"),
    },
  });
  const update = useUpdateTrigger({
    mutation: {
      onSuccess: () => {
        void refresh();
        toast({ title: "Innesco salvato" });
        onOpenChange(false);
      },
      onError: onError("Salvataggio non riuscito"),
    },
  });
  const test = useTestAgentTriggerConfig({
    mutation: {
      onSuccess: (result) => {
        setTestResult(result);
        setTestError(null);
      },
      onError: (error) => {
        setTestResult(null);
        setTestError(apiErrorMessage(error));
      },
    },
  });

  const submit = () => {
    const built = buildInput(form);
    if (!built.ok) return setFormError(built.error);
    setFormError(null);
    if (trigger) {
      // Il tipo non cambia: nel PATCH solo i campi del tipo, con null = tolto
      const { kind: _kind, ...patch } = built.value;
      update.mutate({ id: trigger.id, data: patch as TriggerPatch });
    } else {
      create.mutate({ id: agent.id, data: built.value });
    }
  };

  const runTest = () => {
    const built = buildInput(form);
    if (!built.ok) return setFormError(built.error);
    setFormError(null);
    test.mutate({ id: agent.id, data: built.value });
  };

  const pending = create.isPending || update.isPending;
  const isPoll = form.kind === "poll";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{trigger ? "Modifica innesco" : "Nuovo innesco"}</DialogTitle>
          <DialogDescription>
            {isPoll
              ? "Botcave interroga il tool a intervalli e avvia una run per ogni elemento nuovo. Al primo giro registra ciò che c'è già, senza avviare run."
              : "Un indirizzo segreto: ogni chiamata ricevuta avvia una run dell'agente."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!trigger && (
            <div className="space-y-1.5">
              <Label htmlFor="trigger-kind">Tipo</Label>
              <Select value={form.kind} onValueChange={(value) => set("kind")(value as FormState["kind"])}>
                <SelectTrigger id="trigger-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="poll">Sorveglianza</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <TextField id="trigger-name" label="Nome" value={form.name} onChange={set("name")} />
          <div className="space-y-1.5">
            <Label htmlFor="trigger-instructions">Istruzioni</Label>
            <Textarea
              id="trigger-instructions"
              rows={3}
              value={form.instructions}
              onChange={(event) => set("instructions")(event.target.value)}
              placeholder="Cosa deve fare l'agente quando arriva un elemento"
            />
            <p className="text-xs text-ink-muted">Aprono l'input di ogni run; seguono i dati dell'elemento.</p>
          </div>

          {isPoll ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="trigger-tool">Tool</Label>
                <Select value={form.toolId} onValueChange={set("toolId")}>
                  <SelectTrigger id="trigger-tool">
                    <SelectValue placeholder={toolOptions.length === 0 ? "Nessun tool idoneo" : "Scegli un tool"} />
                  </SelectTrigger>
                  <SelectContent>
                    {toolOptions.map((tool) => (
                      <SelectItem key={tool.id} value={String(tool.id)}>
                        <span className="font-mono text-sm">{tool.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-ink-muted">Solo tool attivi dell'app, di lettura (L0) e con identità di servizio.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trigger-args">Argomenti (JSON)</Label>
                <Textarea
                  id="trigger-args"
                  rows={3}
                  className="font-mono text-sm"
                  value={form.args}
                  onChange={(event) => set("args")(event.target.value)}
                  placeholder='{"limit": 50}'
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField id="trigger-items" label="Percorso dell'elenco" mono value={form.itemsPath} onChange={set("itemsPath")} hint="Vuoto: la risposta è l'elenco." />
                <TextField id="trigger-id" label="Campo id" mono value={form.idField} onChange={set("idField")} />
                <TextField id="trigger-version" label="Campo versione" mono value={form.versionField} onChange={set("versionField")} hint="Facoltativo: un elemento cambiato riparte." />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField id="trigger-cursor-param" label="Cursore: argomento" mono value={form.cursorParam} onChange={set("cursorParam")} />
                <TextField id="trigger-cursor-field" label="Cursore: campo" mono value={form.cursorField} onChange={set("cursorField")} />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField id="trigger-filter-field" label="Filtro: campo" mono value={form.filterField} onChange={set("filterField")} />
                <TextField id="trigger-filter-equals" label="Filtro: valore" mono value={form.filterEquals} onChange={set("filterEquals")} hint="Testo, numero o true/false." />
                <TextField
                  id="trigger-minutes"
                  label="Intervallo (minuti)"
                  mono
                  value={form.minutes}
                  onChange={set("minutes")}
                  hint={`Da ${MIN_INTERVAL_MINUTES} a ${MAX_INTERVAL_MINUTES}.`}
                />
              </div>

              <div className="space-y-2 border-t pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" disabled={test.isPending} onClick={runTest}>
                    {test.isPending ? "Prova in corso…" : "Prova"}
                  </Button>
                  <span className="text-xs text-ink-muted">Chiama il tool una volta, senza avviare run né salvare nulla.</span>
                </div>
                {testError && <p className="text-sm text-danger">{testError}</p>}
                {testResult && <TriggerTestTable result={testResult} />}
              </div>
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="trigger-id" label="Campo id" mono value={form.idField} onChange={set("idField")} hint="Facoltativo: percorso dell'id nel corpo, per riconoscere i doppioni." />
              <TextField id="trigger-dedup" label="Intestazione di deduplicazione" mono value={form.dedupHeader} onChange={set("dedupHeader")} hint="Facoltativo, ad esempio X-GitHub-Delivery." />
            </div>
          )}

          {formError && <p className="text-sm text-danger">{formError}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? "Salvataggio…" : trigger ? "Salva innesco" : "Crea innesco"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
