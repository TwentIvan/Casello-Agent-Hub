import { useState } from "react";
import { Plus } from "lucide-react";
import { getListAppToolsQueryKey, getListAppsQueryKey, useListAppTools, useListApps } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api-errors";
import { TOOL_LEVEL_LABELS } from "@/lib/tool-labels";
import type { ToolRef } from "./role-draft";

interface ToolPickerProps {
  /** Id già presenti nel ruolo (non si ripropongono). */
  exclude: number[];
  onPick: (tool: ToolRef) => void;
  disabled?: boolean;
}

/**
 * Scelta di uno strumento da qualunque app: prima l'app, poi lo strumento con ricerca. Si propongono solo gli
 * strumenti attivi e con livello effettivo diverso da L3 (le regole delle squadre rifiutano gli altri).
 */
export function ToolPicker({ exclude, onPick, disabled }: ToolPickerProps) {
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState<number | null>(null);
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey(), enabled: open } });
  const tools = useListAppTools(appId ?? 0, {
    query: { queryKey: getListAppToolsQueryKey(appId ?? 0), enabled: open && appId !== null },
  });
  const appName = apps.data?.find((a) => a.id === appId)?.name;
  const options = (tools.data ?? [])
    .filter((t) => t.status === "active" && (t.levelOverride ?? t.level) !== "L3" && !exclude.includes(t.id))
    .sort((a, b) => a.name.localeCompare(b.name, "it"));

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Plus />
          Strumento
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-2" align="start">
        {apps.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare le app: {apiErrorMessage(apps.error)}</p>
        ) : (
          <Select value={appId === null ? "" : String(appId)} onValueChange={(v) => setAppId(Number(v))}>
            <SelectTrigger aria-label="App dello strumento">
              <SelectValue placeholder={apps.isLoading ? "Caricamento…" : "Scegli un'app"} />
            </SelectTrigger>
            <SelectContent>
              {(apps.data ?? []).map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {appId !== null && (
          <Command className="rounded-md border">
            <CommandInput placeholder="Cerca uno strumento…" />
            <CommandList>
              {tools.isError ? (
                <p className="p-3 text-sm text-destructive">
                  Impossibile caricare gli strumenti: {apiErrorMessage(tools.error)}
                </p>
              ) : tools.isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Caricamento…</p>
              ) : (
                <CommandEmpty>Nessuno strumento utilizzabile</CommandEmpty>
              )}
              <CommandGroup>
                {options.map((t) => {
                  const level = t.levelOverride ?? t.level;
                  return (
                    <CommandItem
                      key={t.id}
                      value={`${t.name} #${t.id}`}
                      onSelect={() => {
                        onPick({ id: t.id, appName, name: t.name, level, available: true });
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs">{t.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{TOOL_LEVEL_LABELS[level]}</span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
