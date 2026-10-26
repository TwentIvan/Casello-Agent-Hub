import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import type { AiProviderStatus, ListCatalogModelsParams } from "@workspace/api-client-react";

export type CatalogView = "model" | "provider";
export type CatalogSort = NonNullable<ListCatalogModelsParams["sort"]>;

const SORTS: CatalogSort[] = ["price", "released", "context", "name"];
const STATUSES: AiProviderStatus[] = ["managed", "coming", "unmanaged"];
const DEBOUNCE_MS = 300;
export const DEFAULT_MODE = "chat";

export interface CatalogQuery {
  view: CatalogView;
  q: string;
  mode: string;
  authors: string[];
  providers: string[];
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  usable: boolean;
  includeRetired: boolean;
  maxPrice: string;
  minContext: string;
  sort: CatalogSort;
  page: number;
  /** Filtro di stato della vista per provider. */
  status: AiProviderStatus | "";
}

function parse(search: string): CatalogQuery {
  const p = new URLSearchParams(search);
  const flag = (k: string) => p.get(k) === "1";
  const num = (k: string) => {
    const v = p.get(k) ?? "";
    return v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? v : "";
  };
  const sort = p.get("sort") as CatalogSort;
  const status = p.get("status") as AiProviderStatus;
  const page = Number.parseInt(p.get("page") ?? "1", 10);
  return {
    view: p.get("view") === "provider" ? "provider" : "model",
    q: p.get("q") ?? "",
    mode: p.get("mode") || DEFAULT_MODE,
    authors: p.getAll("author"),
    providers: p.getAll("provider"),
    tools: flag("tools"),
    vision: flag("vision"),
    reasoning: flag("reasoning"),
    usable: flag("usable"),
    includeRetired: flag("retired"),
    maxPrice: num("maxPrice"),
    minContext: num("minContext"),
    sort: SORTS.includes(sort) ? sort : "price",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    status: STATUSES.includes(status) ? status : "",
  };
}

/** Scrive solo ciò che differisce dai predefiniti (modo chat, ordinamento per prezzo, pagina 1). */
function serialize(s: CatalogQuery): string {
  const p = new URLSearchParams();
  if (s.view === "provider") p.set("view", "provider");
  if (s.q) p.set("q", s.q);
  if (s.mode !== DEFAULT_MODE) p.set("mode", s.mode);
  s.authors.forEach((a) => p.append("author", a));
  s.providers.forEach((a) => p.append("provider", a));
  if (s.tools) p.set("tools", "1");
  if (s.vision) p.set("vision", "1");
  if (s.reasoning) p.set("reasoning", "1");
  if (s.usable) p.set("usable", "1");
  if (s.includeRetired) p.set("retired", "1");
  if (s.maxPrice) p.set("maxPrice", s.maxPrice);
  if (s.minContext) p.set("minContext", s.minContext);
  if (s.sort !== "price") p.set("sort", s.sort);
  if (s.status) p.set("status", s.status);
  if (s.page > 1) p.set("page", String(s.page));
  return p.toString();
}

/** Parametri dell'API per la vista per modello. */
export function toModelParams(s: CatalogQuery, pageSize: number): ListCatalogModelsParams {
  return {
    q: s.q || undefined,
    mode: s.mode as ListCatalogModelsParams["mode"],
    author: s.authors.length ? s.authors : undefined,
    provider: s.providers.length ? s.providers : undefined,
    tools: s.tools || undefined,
    vision: s.vision || undefined,
    reasoning: s.reasoning || undefined,
    usable: s.usable || undefined,
    includeRetired: s.includeRetired || undefined,
    maxPrice: s.maxPrice ? Number(s.maxPrice) : undefined,
    minContext: s.minContext ? Number(s.minContext) : undefined,
    sort: s.sort,
    page: s.page,
    pageSize,
  };
}

/** Campo digitato subito e applicato dopo 300 ms di pausa; non viene sovrascritto dall'URL mentre l'attesa è in corso. */
function useDebouncedField(value: string, commit: (value: string) => void) {
  const [input, setInput] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const type = useCallback(
    (next: string) => {
      setInput(next);
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        commitRef.current(next);
      }, DEBOUNCE_MS);
    },
    [cancel],
  );
  /** Cambio programmatico: annulla l'attesa e imposta il campo. */
  const set = useCallback(
    (next: string) => {
      cancel();
      setInput(next);
    },
    [cancel],
  );
  // Se l'URL cambia da fuori (indietro, azzera filtri) il campo si riallinea, salvo attesa in corso
  useEffect(() => {
    if (!timer.current) setInput(value);
  }, [value]);
  useEffect(() => cancel, [cancel]);
  return { input, type, set };
}

/**
 * Stato della pagina Modelli nella query string: vista, filtri, ordinamento e pagina.
 * Testo, prezzo massimo e contesto minimo si digitano subito e arrivano nell'URL, e quindi nella ricerca,
 * dopo 300 ms di pausa. Ogni modifica a un filtro riporta alla pagina 1.
 */
export function useCatalogQueryState() {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const state = useMemo(() => parse(search), [search]);

  const latest = useRef({ ...state, path });
  latest.current = { ...state, path };

  const write = useCallback(
    (next: CatalogQuery) => {
      const qs = serialize(next);
      navigate(qs ? `${latest.current.path}?${qs}` : latest.current.path, { replace: true });
    },
    [navigate],
  );

  /** Cambia uno o più campi; la pagina torna a 1 salvo che si cambi proprio la pagina. */
  const rawUpdate = useCallback(
    (patch: Partial<CatalogQuery>) => {
      write({ ...latest.current, ...("page" in patch ? {} : { page: 1 }), ...patch });
    },
    [write],
  );

  const text = useDebouncedField(state.q, (q) => rawUpdate({ q }));
  const price = useDebouncedField(state.maxPrice, (maxPrice) => rawUpdate({ maxPrice }));
  const context = useDebouncedField(state.minContext, (minContext) => rawUpdate({ minContext }));

  const update = useCallback(
    (patch: Partial<CatalogQuery>) => {
      // Un cambio programmatico di un campo ritardato annulla il testo in attesa
      if ("q" in patch) text.set(patch.q ?? "");
      if ("maxPrice" in patch) price.set(patch.maxPrice ?? "");
      if ("minContext" in patch) context.set(patch.minContext ?? "");
      rawUpdate(patch);
    },
    [rawUpdate, text.set, price.set, context.set],
  );

  const reset = useCallback(() => {
    text.set("");
    price.set("");
    context.set("");
    write({ ...parse(""), view: latest.current.view });
  }, [write, text.set, price.set, context.set]);

  return {
    state,
    update,
    reset,
    textInput: text.input,
    setTextInput: text.type,
    priceInput: price.input,
    setPriceInput: price.type,
    contextInput: context.input,
    setContextInput: context.type,
  };
}
