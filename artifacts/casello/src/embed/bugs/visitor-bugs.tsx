// Accesso dell'iframe alle route pubbliche delle segnalazioni dei bug: chiave del browser, identità dell'app ospite con un
// solo nuovo tentativo dopo un 401, pagina da allegare; condiviso dal pannello del visitatore e dalla scheda «Segnalazioni».
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getListEmbedBugsQueryKey,
  listEmbedBugs,
  useListEmbedBugs,
  type EmbedBugCreatePageContext,
} from "@workspace/api-client-react";
import type { HostState } from "../use-host";
import { loadOrCreateBrowserKey } from "./browser-key";
import { bugRequestInit, withIdentityRetry } from "./visitor-request";

// Con l'identità configurata si aspetta il primo messaggio `identity` della pagina ospite, al più 5 s: altrimenti la
// prima segnalazione partirebbe come richiedente «browser».
const IDENTITY_FIRST_WAIT_MS = 5_000;

export interface VisitorBugsApi {
  /** Segnalazioni attive per l'App della pagina ospite. */
  enabled: boolean;
  params: { app: string; origin: string };
  /** Pronto a chiamare: identità arrivata o non configurata. */
  ready: boolean;
  /** Parte delle chiavi delle query: le segnalazioni cambiano tra richiedente «browser» e identità. */
  requester: "identity" | "browser";
  /** Pagina dell'app ospite da allegare alla segnalazione, o null. */
  pageContext: EmbedBugCreatePageContext | null;
  /** Esegue una chiamata del client generato con gli header del visitatore; un 401 chiede un'identità nuova e riprova una volta. */
  call<T>(fn: (init: RequestInit) => Promise<T>): Promise<T>;
}

const VisitorBugsContext = createContext<VisitorBugsApi | null>(null);

export function VisitorBugsProvider({ host, children }: { host: HostState; children: ReactNode }) {
  const [browserKey] = useState(() => loadOrCreateBrowserKey(host.appSlug));
  const identityRef = useRef(host.identity);
  identityRef.current = host.identity;
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), IDENTITY_FIRST_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const { requestIdentity } = host;
  const call = useCallback(
    <T,>(fn: (init: RequestInit) => Promise<T>) =>
      withIdentityRetry((identity) => fn(bugRequestInit(browserKey, identity)), requestIdentity, identityRef.current),
    [browserKey, requestIdentity],
  );

  const { context } = host;
  const pageContext = useMemo<EmbedBugCreatePageContext | null>(() => {
    if (!context) return null;
    const out: EmbedBugCreatePageContext = { page: context.page };
    if (context.id !== undefined) out.id = context.id;
    if (context.title !== undefined) out.title = context.title;
    return out;
  }, [context]);

  const value = useMemo<VisitorBugsApi>(
    () => ({
      enabled: host.bugs.enabled,
      params: { app: host.appSlug, origin: host.origin ?? "" },
      ready: host.bugs.enabled && (!host.bugs.identity || host.identityReceived || waited),
      requester: host.identity ? "identity" : "browser",
      pageContext,
      call,
    }),
    [host.bugs.enabled, host.bugs.identity, host.appSlug, host.origin, host.identityReceived, host.identity, waited, pageContext, call],
  );
  return <VisitorBugsContext.Provider value={value}>{children}</VisitorBugsContext.Provider>;
}

export function useVisitorBugs(): VisitorBugsApi {
  const api = useContext(VisitorBugsContext);
  if (!api) throw new Error("useVisitorBugs fuori da VisitorBugsProvider");
  return api;
}

/** Chiave delle query dell'elenco del visitatore (anche per invalidarle). */
export function visitorListKey(api: Pick<VisitorBugsApi, "params" | "requester">) {
  return [...getListEmbedBugsQueryKey(api.params), api.requester] as const;
}

/** Le segnalazioni del visitatore (al più 50); `refetchInterval` per il contatore del pulsante. */
export function useVisitorBugList(refetchInterval?: number | false) {
  const api = useVisitorBugs();
  return useListEmbedBugs(api.params, {
    query: {
      queryKey: visitorListKey(api),
      queryFn: ({ signal }) => api.call((init) => listEmbedBugs(api.params, { ...init, signal })),
      enabled: api.ready,
      refetchInterval,
      refetchIntervalInBackground: true,
    },
  });
}
