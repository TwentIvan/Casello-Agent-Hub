import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { CatalogQuery, CatalogSort } from "@/lib/catalog-query";

const MODES: { value: string; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "all", label: "Tutti i tipi" },
  { value: "embedding", label: "Embedding" },
  { value: "image_generation", label: "Generazione immagini" },
  { value: "image_edit", label: "Modifica immagini" },
  { value: "audio_transcription", label: "Trascrizione audio" },
  { value: "audio_speech", label: "Sintesi vocale" },
  { value: "video_generation", label: "Generazione video" },
  { value: "rerank", label: "Rerank" },
  { value: "moderation", label: "Moderazione" },
  { value: "ocr", label: "OCR" },
  { value: "search", label: "Ricerca" },
  { value: "realtime", label: "Realtime" },
  { value: "responses", label: "Responses" },
  { value: "completion", label: "Completion" },
  { value: "other", label: "Altro" },
];

export const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.value, m.label]));

const SORTS: { value: CatalogSort; label: string }[] = [
  { value: "price", label: "Prezzo più basso" },
  { value: "released", label: "Più recenti" },
  { value: "context", label: "Contesto più grande" },
  { value: "name", label: "Nome" },
];

interface MultiSelectProps {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
}

/** Selezione multipla con ricerca (Popover + Command). */
function MultiSelect({ label, options, selected, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} aria-label={label} className="w-48 justify-between">
          <span className="truncate">{selected.length ? `${label} (${selected.length})` : label}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Cerca ${label.toLowerCase()}`} />
          <CommandList>
            <CommandEmpty>Nessun risultato.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => toggle(o.value)}>
                  <Check className={cn("size-4", selected.includes(o.value) ? "opacity-100" : "opacity-0")} />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface CatalogFiltersProps {
  state: CatalogQuery;
  update: (patch: Partial<CatalogQuery>) => void;
  reset: () => void;
  textInput: string;
  setTextInput: (value: string) => void;
  priceInput: string;
  setPriceInput: (value: string) => void;
  contextInput: string;
  setContextInput: (value: string) => void;
  /** Autori presenti nei risultati correnti. */
  authors: string[];
  providers: { value: string; label: string }[];
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

/** Barra dei filtri della vista per modello. */
export function CatalogFilters({ state, update, reset, textInput, setTextInput, priceInput, setPriceInput, contextInput, setContextInput, authors, providers }: CatalogFiltersProps) {
  const authorOptions = Array.from(new Set([...authors, ...state.authors]))
    .sort((a, b) => a.localeCompare(b))
    .map((a) => ({ value: a, label: a }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Cerca modelli"
          placeholder="Cerca per nome, autore o id"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          className="w-72"
        />
        <Select value={state.mode} onValueChange={(mode) => update({ mode })}>
          <SelectTrigger className="w-52" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <MultiSelect label="Autore" options={authorOptions} selected={state.authors} onChange={(authors) => update({ authors })} />
        <MultiSelect label="Provider" options={providers} selected={state.providers} onChange={(providers) => update({ providers })} />
        <Select value={state.sort} onValueChange={(sort) => update({ sort: sort as CatalogSort })}>
          <SelectTrigger className="w-52" aria-label="Ordinamento">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Toggle id="f-tools" label="Strumenti" checked={state.tools} onChange={(tools) => update({ tools })} />
        <Toggle id="f-vision" label="Visione" checked={state.vision} onChange={(vision) => update({ vision })} />
        <Toggle id="f-reasoning" label="Ragionamento" checked={state.reasoning} onChange={(reasoning) => update({ reasoning })} />
        <Toggle id="f-usable" label="Solo utilizzabili da me" checked={state.usable} onChange={(usable) => update({ usable })} />
        <Toggle id="f-retired" label="Mostra ritirati" checked={state.includeRetired} onChange={(includeRetired) => update({ includeRetired })} />
        <div className="flex items-center gap-2">
          <Label htmlFor="f-price">Prezzo massimo ($ per Mtok)</Label>
          <Input
            id="f-price"
            type="number"
            min={0}
            step="any"
            className="w-24"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="f-context">Contesto minimo (token)</Label>
          <Input
            id="f-context"
            type="number"
            min={0}
            step={1000}
            className="w-28"
            value={contextInput}
            onChange={(e) => setContextInput(e.target.value)}
          />
        </div>
        <Button variant="ghost" onClick={reset}>
          Azzera filtri
        </Button>
      </div>
    </div>
  );
}
