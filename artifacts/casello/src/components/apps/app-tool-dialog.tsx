import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AppTool,
  ToolIdentity,
  ToolStatus,
  getListAppToolsQueryKey,
  useCreateAppTool,
  useUpdateAppTool,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { jsonObjectInput, parseJsonObject } from "@/lib/json-schema-input";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type ParamLocation = "path" | "query" | "body";
const LOCATIONS: { value: ParamLocation; label: string }[] = [
  { value: "path", label: "Percorso" },
  { value: "query", label: "Query string" },
  { value: "body", label: "Corpo" },
];

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  draft: "Bozza",
  active: "Attivo",
  disabled: "Disattivato",
};
export const TOOL_IDENTITY_LABELS: Record<ToolIdentity, string> = {
  user: "Utente",
  service: "Servizio",
};

const toolFormSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/, "Solo lettere, numeri, _ e -, fino a 64 caratteri (es. elenco_giocatori)."),
  description: z.string().trim(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().trim().min(1, "Il percorso è obbligatorio."),
  paramsSchema: jsonObjectInput,
  responseFields: z.string().trim(),
  identity: z.enum(["user", "service"]),
  requiresConfirmation: z.boolean(),
  readOnly: z.boolean(),
  status: z.enum(["draft", "active", "disabled"]),
});

type ToolFormValues = z.infer<typeof toolFormSchema>;

const SCHEMA_PLACEHOLDER = `{
  "type": "object",
  "properties": {
    "teamId": { "type": "string" }
  },
  "required": ["teamId"]
}`;

function placeholdersOf(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}

function defaultLocation(method: string, path: string, param: string): ParamLocation {
  if (placeholdersOf(path).includes(param)) return "path";
  return method === "GET" || method === "DELETE" ? "query" : "body";
}

function asStringRecord(value: unknown): Record<string, ParamLocation> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, ParamLocation> = {};
  for (const [key, loc] of Object.entries(value)) {
    if (loc === "path" || loc === "query" || loc === "body") out[key] = loc;
  }
  return out;
}

function toValues(tool?: AppTool): ToolFormValues {
  const definition = (tool?.definition ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(definition.responseFields) ? definition.responseFields.map(String) : [];
  return {
    name: tool?.name ?? "",
    description: tool?.description ?? "",
    method: (HTTP_METHODS as readonly string[]).includes(String(definition.method))
      ? (definition.method as ToolFormValues["method"])
      : "GET",
    path: typeof definition.path === "string" ? definition.path : "",
    paramsSchema:
      tool && Object.keys(tool.paramsSchema).length > 0 ? JSON.stringify(tool.paramsSchema, null, 2) : "",
    responseFields: fields.join(", "),
    identity: tool?.identity ?? "user",
    requiresConfirmation: tool?.requiresConfirmation ?? false,
    readOnly: tool?.readOnly ?? false,
    status: tool?.status ?? "active",
  };
}

interface AppToolDialogProps {
  appId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tool da modificare; assente per crearne uno nuovo. */
  tool?: AppTool;
}

export function AppToolDialog({ appId, open, onOpenChange, tool }: AppToolDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<ToolFormValues>({ resolver: zodResolver(toolFormSchema), defaultValues: toValues(tool) });
  // Scelte esplicite dell'utente; le altre posizioni derivano da metodo e percorso.
  const [chosen, setChosen] = useState<Record<string, ParamLocation>>(() =>
    asStringRecord((tool?.definition as Record<string, unknown> | undefined)?.paramLocations),
  );

  const [method, path, schemaText] = form.watch(["method", "path", "paramsSchema"]);
  const paramNames = useMemo(() => {
    const properties = parseJsonObject(schemaText)?.properties;
    return typeof properties === "object" && properties !== null && !Array.isArray(properties)
      ? Object.keys(properties)
      : [];
  }, [schemaText]);
  const locationOf = (param: string): ParamLocation =>
    placeholdersOf(path).includes(param) ? "path" : (chosen[param] ?? defaultLocation(method, path, param));

  const onSuccess = (saved: AppTool) => {
    void queryClient.invalidateQueries({ queryKey: getListAppToolsQueryKey(appId) });
    toast({ title: tool ? "Tool aggiornato" : "Tool creato", description: saved.name });
    onOpenChange(false);
  };
  const onError = (error: unknown) =>
    toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) });
  const createTool = useCreateAppTool({ mutation: { onSuccess, onError } });
  const updateTool = useUpdateAppTool({ mutation: { onSuccess, onError } });
  const saving = createTool.isPending || updateTool.isPending;

  const onSubmit = (values: ToolFormValues) => {
    const paramsSchema = values.paramsSchema
      ? (JSON.parse(values.paramsSchema) as Record<string, unknown>)
      : { type: "object", properties: {} };
    const responseFields = values.responseFields
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    const paramLocations = Object.fromEntries(paramNames.map((param) => [param, locationOf(param)]));
    const definition = {
      method: values.method,
      path: values.path,
      paramLocations,
      ...(responseFields.length > 0 ? { responseFields } : {}),
    };
    const data = {
      name: values.name,
      description: values.description || null,
      kind: "http" as const,
      identity: values.identity,
      requiresConfirmation: values.requiresConfirmation,
      readOnly: values.readOnly,
      status: values.status,
      paramsSchema,
      definition,
    };
    if (tool) updateTool.mutate({ id: appId, toolId: tool.id, data });
    else createTool.mutate({ id: appId, data });
  };

  // Tool `ui` e `composite`: nella fase 1 si possono solo vedere.
  if (tool && tool.kind !== "http") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{tool.name}</DialogTitle>
            <DialogDescription>
              Tool di tipo «{tool.kind}»: nella fase 1 è modificabile solo lo stato, dal menu del catalogo.
            </DialogDescription>
          </DialogHeader>
          {tool.description && <p className="text-sm">{tool.description}</p>}
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Schema dei parametri</div>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(tool.paramsSchema, null, 2)}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Definizione</div>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(tool.definition, null, 2)}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Chiudi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tool ? "Modifica tool" : "Nuovo tool"}</DialogTitle>
          <DialogDescription>Una chiamata HTTP all'app che gli agenti possono usare.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input placeholder="es. elenco_giocatori" className="font-mono" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Descrizione</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="Cosa fa e quando usarlo: la legge il modello." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
              <FormField
                control={form.control}
                name="method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Metodo</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {HTTP_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="path"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Percorso</FormLabel>
                    <FormControl>
                      <Input placeholder="es. /teams/{teamId}/players" className="font-mono" {...field} />
                    </FormControl>
                    <FormDescription>
                      Rispetto all'indirizzo dell'app. Ogni {"{segnaposto}"} deve essere un parametro obbligatorio dello schema.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="paramsSchema"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schema dei parametri (JSON)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={8}
                      spellCheck={false}
                      placeholder={SCHEMA_PLACEHOLDER}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>Facoltativo. JSON Schema dei parametri accettati.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {paramNames.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="text-sm font-medium">Posizione dei parametri</div>
                {paramNames.map((param) => {
                  const inPath = placeholdersOf(path).includes(param);
                  return (
                    <div key={param} className="flex items-center justify-between gap-3">
                      <code className="truncate text-xs">{param}</code>
                      <Select
                        value={locationOf(param)}
                        disabled={inPath}
                        onValueChange={(value) => setChosen((prev) => ({ ...prev, [param]: value as ParamLocation }))}
                      >
                        <SelectTrigger className="w-40" aria-label={`Posizione di ${param}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LOCATIONS.map((loc) => (
                            <SelectItem key={loc.value} value={loc.value}>
                              {loc.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            )}
            <FormField
              control={form.control}
              name="responseFields"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Campi della risposta</FormLabel>
                  <FormControl>
                    <Input placeholder="es. id, name, score" className="font-mono" {...field} />
                  </FormControl>
                  <FormDescription>Facoltativi, separati da virgole. Vuoto = tutta la risposta.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="identity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Identità</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.values(ToolIdentity).map((value) => (
                          <SelectItem key={value} value={value}>
                            {TOOL_IDENTITY_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stato</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.values(ToolStatus).map((value) => (
                          <SelectItem key={value} value={value}>
                            {TOOL_STATUS_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="space-y-3">
              <FormField
                control={form.control}
                name="requiresConfirmation"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                    </FormControl>
                    <div className="space-y-0.5">
                      <FormLabel>Richiede conferma</FormLabel>
                      <FormDescription>La run si ferma e chiede l'ok dell'utente prima di eseguire il tool.</FormDescription>
                    </div>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="readOnly"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                    </FormControl>
                    <div className="space-y-0.5">
                      <FormLabel>Sola lettura</FormLabel>
                      <FormDescription>Il tool non modifica dati nell'app.</FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annulla
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Salvataggio…" : tool ? "Salva" : "Aggiungi"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
