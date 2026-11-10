import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type TeamInstance,
  type TeamUpdateItem,
  getGetTeamInstanceQueryKey,
  getGetTeamInstanceUpdatesQueryKey,
  getListTeamInstancesQueryKey,
  useApplyTeamInstanceUpdates,
  useGetTeamInstanceUpdates,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiModelGroups } from "@/components/ai/ai-queries";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { RUNS_ON_LABELS } from "./role-draft";

const FIELD_LABELS: Record<NonNullable<TeamUpdateItem["field"]>, string> = {
  name: "nome",
  task: "compito",
  isLead: "capo",
  runsOn: "dove gira",
  aiModelId: "modello",
  tools: "strumenti",
  code: "codice",
};

/** Testo di una voce: cosa cambierebbe applicandola. */
function describe(item: TeamUpdateItem): string {
  const role = `«${item.roleName}»`;
  switch (item.type) {
    case "role_added":
      return `Nuovo ruolo ${role} dal modello`;
    case "role_removed":
      return `Il ruolo ${role} non è più nel modello: toglierlo`;
    case "role_changed":
      return `${role}: cambia ${item.field ? FIELD_LABELS[item.field] : "un campo"}`;
    case "skill_added":
      return `${role}: aggiungere la skill ${item.skillCode}`;
    case "skill_removed":
      return `${role}: togliere la skill ${item.skillCode}`;
    case "skill_version":
      return `${role}: skill ${item.skillCode} dalla versione ${item.fromVersion} alla ${item.toVersion}`;
  }
}

/** Valore leggibile di un campo di ruolo (attuale o proposto). */
function useFormatValue(team: TeamInstance) {
  const models = useAiModelGroups();
  const toolNames = new Map(team.roles.flatMap((r) => r.tools.map((t) => [t.id, t.name] as const)));
  return (field: TeamUpdateItem["field"], value: unknown): string => {
    if (value === null || value === undefined) return "nessuno";
    switch (field) {
      case "isLead":
        return value ? "sì" : "no";
      case "runsOn":
        return RUNS_ON_LABELS[value as keyof typeof RUNS_ON_LABELS] ?? String(value);
      case "aiModelId": {
        const model = models.data?.flatMap((g) => g.models).find((m) => m.id === value);
        return model?.displayName ?? `modello #${String(value)}`;
      }
      case "tools": {
        const ids = Array.isArray(value) ? (value as number[]) : [];
        return ids.length === 0 ? "nessuno" : ids.map((id) => toolNames.get(id) ?? `#${id}`).join(", ");
      }
      default:
        return typeof value === "string" ? value || "(vuoto)" : JSON.stringify(value);
    }
  };
}

function UpdateRow({
  item,
  checked,
  onCheckedChange,
  format,
}: {
  item: TeamUpdateItem;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  format: ReturnType<typeof useFormatValue>;
}) {
  const id = `update-${item.id}`;
  return (
    <li className="flex items-start gap-3 py-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} className="mt-0.5" />
      <label htmlFor={id} className="min-w-0 flex-1 space-y-1 text-sm">
        <span className="block break-words">{describe(item)}</span>
        {item.type === "role_changed" && (
          <span className="grid gap-1 text-xs sm:grid-cols-2">
            <span className="min-w-0">
              <span className="text-muted-foreground">Attuale: </span>
              <span className="line-clamp-3 whitespace-pre-wrap break-words">{format(item.field, item.from)}</span>
            </span>
            <span className="min-w-0">
              <span className="text-muted-foreground">Nel modello: </span>
              <span className="line-clamp-3 whitespace-pre-wrap break-words">{format(item.field, item.to)}</span>
            </span>
          </span>
        )}
      </label>
    </li>
  );
}

/**
 * Aggiornamenti proposti dal modello e dalle skill del catalogo: si spuntano le voci e si applicano insieme
 * (tutto o niente). Con modifiche non salvate nella scheda l'applicazione è sospesa, perché ricarica la squadra.
 */
export function TeamUpdatesCard({ team, dirty }: { team: TeamInstance; dirty: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updatesKey = getGetTeamInstanceUpdatesQueryKey(team.id);
  const updates = useGetTeamInstanceUpdates(team.id, { query: { queryKey: updatesKey } });
  const format = useFormatValue(team);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const items = updates.data?.items ?? [];
  const chosen = items.filter((i) => selected.has(i.id)).map((i) => i.id);

  const apply = useApplyTeamInstanceUpdates({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetTeamInstanceQueryKey(saved.id), saved);
        void queryClient.invalidateQueries({ queryKey: updatesKey });
        void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
        setSelected(new Set());
        toast({ title: "Aggiornamenti applicati" });
      },
      onError: (error) => {
        // «aggiornamenti cambiati: ricarica»: le voci non sono più quelle mostrate
        if (error instanceof ApiError && error.status === 409) {
          void queryClient.invalidateQueries({ queryKey: updatesKey });
          void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceQueryKey(team.id) });
          setSelected(new Set());
        }
        toast({ variant: "destructive", title: "Aggiornamenti non applicati", description: apiErrorMessage(error) });
      },
    },
  });

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Aggiornamenti disponibili</CardTitle>
        <CardDescription>
          Novità del modello{team.template ? ` (da v${team.template.version})` : ""} e nuove versioni delle skill. Le
          modifiche fatte solo nella squadra non vengono proposte; dopo un'applicazione parziale un valore può essere
          riproposto finché non si applicano tutte le modifiche del modello.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {updates.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare gli aggiornamenti: {apiErrorMessage(updates.error)}</p>
        ) : updates.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">La squadra è allineata al modello e alle skill.</p>
        ) : (
          <>
            <label className="flex items-center gap-2 border-b pb-2 text-sm">
              <Checkbox
                checked={chosen.length === items.length ? true : chosen.length > 0 ? "indeterminate" : false}
                onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
              />
              Seleziona tutte ({items.length})
            </label>
            <ul className="divide-y">
              {items.map((item) => (
                <UpdateRow
                  key={item.id}
                  item={item}
                  checked={selected.has(item.id)}
                  onCheckedChange={(c) => toggle(item.id, c)}
                  format={format}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
      {items.length > 0 && (
        <CardFooter className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => apply.mutate({ id: team.id, data: { ids: chosen } })}
            disabled={chosen.length === 0 || dirty || apply.isPending}
          >
            {apply.isPending ? "Applicazione…" : `Applica (${chosen.length})`}
          </Button>
          {dirty && <span className="text-sm text-muted-foreground">Salva prima le modifiche alla squadra.</span>}
        </CardFooter>
      )}
    </Card>
  );
}
