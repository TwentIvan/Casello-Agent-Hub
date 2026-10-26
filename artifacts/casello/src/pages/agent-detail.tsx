import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import {
  type Agent,
  ToolIdentity,
  ApiError,
  getGetAgentQueryKey,
  getGetDashboardStatsQueryKey,
  getGetAppQueryKey,
  getListAgentsQueryKey,
  getListRunsQueryKey,
  useDeleteAgent,
  useGetAgent,
  useGetApp,
  useUpdateAgent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/components/ai/model-picker";
import { AgentRoleBadge } from "@/components/agents/agent-role-badge";
import { AgentToolsSection } from "@/components/agents/agent-tools-section";
import { AgentSkillsSection } from "@/components/agents/agent-skills-section";
import { RunPanel } from "@/components/runs/run-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AGENT_STATUS_LABELS, StatusBadge } from "@/components/status-badge";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { TOOL_IDENTITY_LABELS } from "@/lib/tool-labels";

const agentSchema = z.object({
  name: z.string().trim().min(1, "Il nome è obbligatorio."),
  systemPrompt: z.string(),
  aiModelId: z.number().nullable(),
  status: z.enum(["active", "inactive", "draft"]),
  area: z.string(),
  defaultIdentity: z.enum(["user", "service"]),
});

type AgentValues = z.infer<typeof agentSchema>;

function toValues(agent: Agent): AgentValues {
  return {
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? "",
    aiModelId: agent.aiModelId,
    status: agent.status,
    area: agent.area ?? "",
    defaultIdentity: agent.defaultIdentity,
  };
}

function AgentConfigForm({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<AgentValues>({ resolver: zodResolver(agentSchema), defaultValues: toValues(agent) });

  const updateAgent = useUpdateAgent({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetAgentQueryKey(saved.id), saved);
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        form.reset(toValues(saved));
        toast({ title: "Agente salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const isGeneral = agent.role === "general";
  const onSubmit = ({ area, aiModelId, ...values }: AgentValues) =>
    updateAgent.mutate({
      id: agent.id,
      data: {
        ...values,
        // Il modello si manda solo se è cambiato: un agente configurato da altri resta sul suo.
        ...(aiModelId !== null && aiModelId !== agent.aiModelId ? { aiModelId } : {}),
        systemPrompt: values.systemPrompt.trim() ? values.systemPrompt : null,
        // L'area è solo degli agenti di area: il generale non la manda.
        ...(isGeneral ? {} : { area: area.trim() ? area.trim() : null }),
      },
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Configurazione</CardTitle>
        <CardDescription>Istruzioni, modello e stato dell'agente.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="systemPrompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>System prompt</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={14}
                      placeholder="Chi è l'agente, cosa deve fare, con quale tono, cosa non deve fare…"
                      className="min-h-48 font-mono text-sm leading-relaxed"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Le istruzioni fisse dell'agente. Nome e base URL dell'app e l'elenco degli strumenti vengono
                    aggiunti in automatico a ogni run.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="aiModelId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Modello</FormLabel>
                    <FormControl>
                      <ModelPicker value={field.value} onChange={field.onChange} />
                    </FormControl>
                    {agent.aiModelId === null && (
                      <FormDescription>
                        Ora usa <span className="font-mono">{agent.model}</span> dal vecchio gateway: scegli un modello
                        per passare agli account AI.
                      </FormDescription>
                    )}
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
                        {Object.entries(AGENT_STATUS_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {!isGeneral && (
                <FormField
                  control={form.control}
                  name="area"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Area</FormLabel>
                      <FormControl>
                        <Input placeholder="es. Formazioni" {...field} />
                      </FormControl>
                      <FormDescription>Il dominio di cui l'agente si occupa.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="defaultIdentity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Identità predefinita</FormLabel>
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
                    <FormDescription>Con quale identità l'agente chiama i tool dell'app.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!form.formState.isDirty || updateAgent.isPending}
                onClick={() => form.reset()}
              >
                Annulla modifiche
              </Button>
              <Button type="submit" disabled={!form.formState.isDirty || updateAgent.isPending}>
                {updateAgent.isPending ? "Salvataggio…" : "Salva"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = Number(params.id);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const agent = useGetAgent(agentId, {
    query: { queryKey: getGetAgentQueryKey(agentId), enabled: Number.isInteger(agentId) },
  });
  const appId = agent.data?.appId ?? 0;
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId), enabled: appId > 0 } });

  const deleteAgent = useDeleteAgent({
    mutation: {
      onSuccess: () => {
        for (const queryKey of [getListAgentsQueryKey(), getListRunsQueryKey(), getGetDashboardStatsQueryKey()]) {
          void queryClient.invalidateQueries({ queryKey });
        }
        queryClient.removeQueries({ queryKey: getGetAgentQueryKey(agentId) });
        toast({ title: "Agente eliminato", description: agent.data?.name });
        navigate("/agents");
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const backLink = (
    <Link href="/agents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
      Agenti
    </Link>
  );

  if (!Number.isInteger(agentId) || (agent.error instanceof ApiError && agent.error.status === 404)) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {backLink}
        <p className="text-sm text-muted-foreground">Agente non trovato: potrebbe essere stato eliminato.</p>
      </div>
    );
  }
  if (agent.isError) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {backLink}
        <p className="text-sm text-destructive">Impossibile caricare l'agente: {apiErrorMessage(agent.error)}</p>
      </div>
    );
  }
  if (!agent.data) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {backLink}
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-3">
        {backLink}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight">{agent.data.name}</h2>
              <StatusBadge kind="agent" status={agent.data.status} />
              <AgentRoleBadge agent={agent.data} />
            </div>
            <p className="text-sm text-muted-foreground">
              App:{" "}
              <Link href={`/apps/${agent.data.appId}`} className="font-medium text-foreground hover:underline">
                {app.data?.name ?? "…"}
              </Link>
              {app.data && <span className="ml-2 font-mono text-xs">{app.data.baseUrl}</span>}
            </p>
          </div>
          {agent.data.role !== "general" && (
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              Elimina agente
            </Button>
          )}
        </div>
      </div>

      <RunPanel key={`run-${agent.data.id}`} agent={agent.data} />
      <AgentConfigForm key={`config-${agent.data.id}`} agent={agent.data} />
      <AgentToolsSection key={`tools-${agent.data.id}`} agent={agent.data} />
      <AgentSkillsSection key={`skills-${agent.data.id}`} agent={agent.data} />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Eliminare «${agent.data.name}»?`}
        description="Verranno eliminate anche tutte le sue run e l'assegnazione dei tool. L'operazione non si può annullare."
        pending={deleteAgent.isPending}
        onConfirm={() => deleteAgent.mutate({ id: agentId })}
      />
    </div>
  );
}
