import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  getGetDashboardStatsQueryKey,
  getGetDefaultModelQueryKey,
  getListAgentsQueryKey,
  useCreateAgent,
  useGetDefaultModel,
} from "@workspace/api-client-react";
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
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { ModelPicker } from "@/components/ai/model-picker";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";

const agentCreateSchema = z.object({
  name: z.string().trim().min(1, "Il nome è obbligatorio."),
  appId: z.string().min(1, "Scegli l'app a cui appartiene l'agente."),
  aiModelId: z
    .number()
    .nullable()
    .superRefine((value, ctx) => {
      if (value === null) ctx.addIssue({ code: "custom", message: "Scegli un modello." });
    }),
});

type AgentCreateValues = z.infer<typeof agentCreateSchema>;

interface AgentCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: App[];
  /** App preselezionata (es. dal filtro della lista). */
  defaultAppId?: number;
}

/** Crea l'agente (in bozza) con i dati minimi e apre la sua scheda per il resto della configurazione. */
export function AgentCreateDialog({ open, onOpenChange, apps, defaultAppId }: AgentCreateDialogProps) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  // Precompilazione: il modello predefinito dell'utente; se non c'è, il consigliato dell'account predefinito.
  const userDefault = useGetDefaultModel({ query: { queryKey: getGetDefaultModelQueryKey() } });
  const accountDefault = useDefaultAiModelId();
  const defaultModelId = userDefault.isFetched ? (userDefault.data?.aiModelId ?? accountDefault) : null;
  const form = useForm<AgentCreateValues>({
    resolver: zodResolver(agentCreateSchema),
    defaultValues: { name: "", appId: defaultAppId ? String(defaultAppId) : "", aiModelId: defaultModelId },
  });

  // Predefinito e modelli possono arrivare dopo l'apertura: si preimpostano appena noti.
  useEffect(() => {
    if (defaultModelId !== null && form.getValues("aiModelId") === null) form.setValue("aiModelId", defaultModelId);
  }, [defaultModelId, form]);

  const createAgent = useCreateAgent({
    mutation: {
      onSuccess: (agent) => {
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        toast({ title: "Agente creato", description: "Completa istruzioni e strumenti nella sua scheda." });
        onOpenChange(false);
        navigate(`/agents/${agent.id}`);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const onSubmit = (values: AgentCreateValues) =>
    createAgent.mutate({
      data: { name: values.name, appId: Number(values.appId), aiModelId: values.aiModelId, status: "draft" },
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo agente</DialogTitle>
          <DialogDescription>
            Nasce in bozza: istruzioni, strumenti e stato si configurano nella sua scheda.
          </DialogDescription>
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
                    <Input placeholder="es. Assistente formazioni" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="appId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>App</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Scegli un'app" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {apps.map((app) => (
                        <SelectItem key={app.id} value={String(app.id)}>
                          {app.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>Non si può cambiare dopo la creazione.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="aiModelId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Modello</FormLabel>
                  <FormControl>
                    <ModelPicker value={field.value} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annulla
              </Button>
              <Button type="submit" disabled={createAgent.isPending}>
                {createAgent.isPending ? "Creazione…" : "Crea agente"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
