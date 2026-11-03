import { useState } from "react";
import { Plus } from "lucide-react";
import { getListSkillsQueryKey, useListSkills } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiErrorMessage } from "@/lib/api-errors";
import type { SkillRef } from "./role-draft";
import { SKILL_KIND_LABELS } from "./skill-kind";

const PARAMS = { deprecated: "false" as const };

interface SkillPickerProps {
  /** Codici già presenti nel ruolo (non si ripropongono). */
  exclude: string[];
  /** Le skill del nodo locale si possono usare solo nei ruoli `node`. */
  nodeAllowed: boolean;
  onPick: (skill: SkillRef) => void;
  disabled?: boolean;
}

/** Scelta di una skill del catalogo con ricerca; le deprecate non si propongono per nuove aggiunte. */
export function SkillPicker({ exclude, nodeAllowed, onPick, disabled }: SkillPickerProps) {
  const [open, setOpen] = useState(false);
  const skills = useListSkills(PARAMS, { query: { queryKey: getListSkillsQueryKey(PARAMS), enabled: open } });
  const options = (skills.data ?? []).filter((s) => !exclude.includes(s.code));

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Plus />
          Skill
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Cerca una skill…" />
          <CommandList>
            {skills.isError ? (
              <p className="p-3 text-sm text-destructive">Impossibile caricare le skill: {apiErrorMessage(skills.error)}</p>
            ) : skills.isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">Caricamento…</p>
            ) : (
              <CommandEmpty>Nessuna skill trovata</CommandEmpty>
            )}
            <CommandGroup>
              {options.map((s) => {
                const blocked = s.kind === "node" && !nodeAllowed;
                return (
                  <CommandItem
                    key={s.code}
                    value={`${s.code} ${s.name}`}
                    disabled={blocked}
                    onSelect={() => {
                      onPick({ code: s.code, name: s.name, kind: s.kind, deprecated: false, version: s.currentVersion });
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{s.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {s.code} · {SKILL_KIND_LABELS[s.kind]} · v{s.currentVersion}
                        {blocked && " · solo per ruoli sul nodo"}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
