import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { HttpMethod, getListToolsQueryKey, useCreateTool } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
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

const HTTP_METHODS = Object.values(HttpMethod);

const toolSchema = z.object({
  name: z.string().trim().min(1, "Il nome è obbligatorio."),
  description: z.string().trim(),
  httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  endpoint: z.string().trim().min(1, "L'endpoint è obbligatorio."),
  // Facoltativo, ma se c'è deve essere un oggetto JSON (lo schema dei parametri).
  parametersSchema: z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      if (!value) return;
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Deve essere un oggetto JSON, es. { \"type\": \"object\" }." });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "JSON non valido: controlla virgolette doppie, virgole in più e parentesi.",
        });
      }
    }),
});

type ToolValues = z.infer<typeof toolSchema>;

const SCHEMA_PLACEHOLDER = `{
  "type": "object",
  "properties": {
    "team": { "type": "string" }
  },
  "required": ["team"]
}`;

interface ToolFormDialogProps {
  agentId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolFormDialog({ agentId, open, onOpenChange }: ToolFormDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<ToolValues>({
    resolver: zodResolver(toolSchema),
    defaultValues: { name: "", description: "", httpMethod: "GET", endpoint: "", parametersSchema: "" },
  });

  const createTool = useCreateTool({
    mutation: {
      onSuccess: (tool) => {
        void queryClient.invalidateQueries({ queryKey: getListToolsQueryKey(agentId) });
        toast({ title: "Strumento aggiunto", description: tool.name });
        onOpenChange(false);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const onSubmit = (values: ToolValues) =>
    createTool.mutate({
      id: agentId,
      data: {
        name: values.name,
        description: values.description || undefined,
        httpMethod: values.httpMethod,
        endpoint: values.endpoint,
        // Salvato formattato, così resta leggibile quando lo si rilegge.
        parametersSchema: values.parametersSchema
          ? JSON.stringify(JSON.parse(values.parametersSchema), null, 2)
          : undefined,
      },
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nuovo strumento</DialogTitle>
          <DialogDescription>Una chiamata HTTP all'app che l'agente può usare.</DialogDescription>
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
                    <Input placeholder="es. Elenco giocatori" autoFocus {...field} />
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
                name="httpMethod"
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
                        {HTTP_METHODS.map((method) => (
                          <SelectItem key={method} value={method}>
                            {method}
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
                name="endpoint"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Endpoint</FormLabel>
                    <FormControl>
                      <Input placeholder="es. /api/players" className="font-mono" {...field} />
                    </FormControl>
                    <FormDescription>Percorso rispetto alla base URL dell'app.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="parametersSchema"
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
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annulla
              </Button>
              <Button type="submit" disabled={createTool.isPending}>
                {createTool.isPending ? "Salvataggio…" : "Aggiungi"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
