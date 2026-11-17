// Pagina /embed: il pannello di Botcave dentro l'iframe dell'app ospite.
// Accesso con il token `embed` (auth.ts), mai con il cookie di sessione (richieste con credentials "omit");
// dialogo con l'ospite in use-host.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { QueryCache, QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { Router } from "wouter";
import { ApiError, getCurrentUser, setAuthTokenGetter, setBaseUrl, setRequestCredentials } from "@workspace/api-client-react";
import { getListUnreadTeamEventsQueryKey, useListUnreadTeamEvents, type EmbedStatus } from "@workspace/api-client-react";
import { BotcavePanel, type EmbedPanelChrome } from "@/components/panel/botcave-panel";
import { ContextBar } from "@/components/panel/context-bar";
import { PanelProvider, usePanel, type PanelEnv } from "@/components/panel/panel-context";
import { AlfredVoiceProvider, useSharedAlfredVoice } from "@/components/panel/voice-context";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BotcaveLogo, BotcaveMark } from "@/components/brand/marks";
import { Led } from "@/components/brand/led";
import { isClientError } from "@/lib/api-errors";
import { isUnauthorized } from "@/lib/auth";
import {
  clearTokens,
  completeConnect,
  connectMessage,
  getAccessToken,
  loadTokens,
  onTokensChange,
  setEmbedClient,
  startConnect,
} from "./auth";
import { useHost } from "./use-host";
import { usePanelOpen } from "./use-badge";
import { useStatus } from "./use-status";
import { useBotActivity } from "./use-bot-activity";
import { embedHrefs, useEmbedLocation } from "./embed-location";
import { badgeIntervalMs } from "./panel-helpers";
import { VisitorBugsProvider } from "./bugs/visitor-bugs";
import { VisitorPanel } from "./bugs/visitor-panel";
import { embedTokenGetter, isVisitorBugUrl } from "./bugs/visitor-request";

setBaseUrl(null);
// Le route pubbliche delle segnalazioni dei bug (visitatore) non portano mai il token di Botcave
setAuthTokenGetter(embedTokenGetter(getAccessToken));
// Sugli host dello stesso sito di Botcave il cookie SameSite=Lax arriverebbe all'API anche dall'iframe: mai cookie
setRequestCredentials("omit");

const MESSAGES = {
  popupBlocked: "Consenti i popup per questo sito e riprova",
  notEnabled: "Account non abilitato a Botcave",
  hostNotAllowed: "Questa app non è abilitata a Botcave",
  unreachable: "Botcave non risponde: riprova tra poco",
  failed: "Collegamento non completato: riprova",
} as const;

// Un 401 vuol dire token revocato o non più valido: si torna a «Collega con Botcave». Non sulle route del visitatore,
// dove il 401 riguarda l'identità dell'app ospite e non il collegamento a Botcave.
function onApiError(error: unknown) {
  if (error instanceof ApiError && isVisitorBugUrl(error.url)) return;
  if (isUnauthorized(error)) clearTokens();
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: { retry: (failureCount, error) => !isClientError(error) && failureCount < 3 },
  },
});

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-1 p-6 text-center">{children}</div>;
}

type ConnectState = { busy: boolean; error: string | null };

/** Collegamento: popup, ritorno del codice e verifica dell'utente con GET /api/auth/me. */
function useConnect(clientId: string | null) {
  const [state, setState] = useState<ConnectState>({ busy: false, error: null });

  // Ritorno dal popup: code e state solo dal popup aperto e dall'origine di Botcave
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = connectMessage(event);
      if (!msg) return;
      setState({ busy: true, error: null });
      completeConnect(msg.code, msg.state)
        .then(() => getCurrentUser())
        .then(() => setState({ busy: false, error: null }))
        .catch((err: unknown) => {
          // Un messaggio fuori sequenza (state diverso) non deve cancellare token validi
          if (err instanceof Error && err.message === "state_mismatch") {
            setState((prev) => ({ ...prev, busy: false }));
            return;
          }
          clearTokens();
          setState({ busy: false, error: isUnauthorized(err) ? MESSAGES.notEnabled : MESSAGES.failed });
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const connect = useCallback(() => {
    if (!clientId) return;
    setState({ busy: false, error: null });
    startConnect(clientId).catch((err: unknown) => {
      const blocked = err instanceof Error && err.message === "popup_blocked";
      setState({ busy: false, error: blocked ? MESSAGES.popupBlocked : MESSAGES.failed });
    });
  }, [clientId]);

  return { ...state, connect };
}

function ConnectScreen({ busy, error, onConnect }: ConnectState & { onConnect: () => void }) {
  return (
    <Centered>
      <BotcaveLogo />
      <Button onClick={onConnect} disabled={busy}>
        Collega con Botcave
      </Button>
      {busy && <Led state="work" label="Collegamento in corso" />}
      {error && <Led state="ko" label={error} />}
    </Centered>
  );
}

const UNREAD_EVENTS = { unread: true } as const;
const UNREAD_EVENTS_MS = 30_000;

/** Contatori e LED delle schede, barra «Stai guardando». */
function useChrome(host: ReturnType<typeof useHost>, status: EmbedStatus | null, open: boolean): EmbedPanelChrome {
  const { runAction } = usePanel();
  const voice = useSharedAlfredVoice();
  const { activity, refreshUnwatched } = useBotActivity();
  const [collapsed, setCollapsed] = useState(false);
  const events = useListUnreadTeamEvents(UNREAD_EVENTS, {
    query: { queryKey: getListUnreadTeamEventsQueryKey(UNREAD_EVENTS), refetchInterval: UNREAD_EVENTS_MS },
  });
  const unreadEvents = (events.data ?? []).filter((e) => e.readAt === null).length;

  // Le conversazioni in corso senza scheda montata si rileggono con il ritmo dello stato
  useEffect(() => {
    const timer = setInterval(refreshUnwatched, badgeIntervalMs(open));
    return () => clearInterval(timer);
  }, [refreshUnwatched, open]);

  const context = host.context;
  const actions = status?.actions ?? [];
  return {
    counts: { pending: status?.pending ?? 0, bulletin: unreadEvents, bugs: status?.bugs ?? 0 },
    working: {
      alfred: activity.alfred.running || voice.status !== "stopped",
      lucius: activity.lucius.running,
      lead: activity.lead.running || status?.leadWorking === true,
    },
    contextBar: context ? (
      <ContextBar
        context={context}
        actions={actions}
        onAction={runAction}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
    ) : null,
  };
}

/** Apre il pannello sulla scheda chiesta dalla pagina ospite; schede con contatori e barra del contesto. */
function EmbedPanel({ host, status, open }: { host: ReturnType<typeof useHost>; status: EmbedStatus | null; open: boolean }) {
  const { openPanel } = usePanel();
  const { openRequest } = host;
  const chrome = useChrome(host, status, open);

  // Ogni nuova richiesta `open` (seq diverso) porta sulla scheda chiesta, o su quella corrente se non ne indica
  useEffect(() => {
    if (openRequest) openPanel(openRequest.tab);
  }, [openRequest, openPanel]);

  // Nell'iframe il pannello si mostra sempre: a nasconderlo è il caricatore della pagina ospite
  return (
    <div className="h-dvh">
      <BotcavePanel chrome={chrome} />
    </div>
  );
}

function Shell({ host }: { host: ReturnType<typeof useHost> }) {
  const { appSlug, appName, context, post } = host;
  const open = usePanelOpen(host.openRequest);
  const status = useStatus(open, context, post);
  // Ambiente stabile: un oggetto nuovo a ogni render rinnoverebbe il contesto del pannello
  const env = useMemo<PanelEnv>(
    () => ({
      surface: "embed",
      appSlug,
      appName,
      hostContext: context,
      botNames: status?.botNames ?? null,
      status,
      onClose: () => post({ botcave: 1, type: "close" }),
    }),
    [appSlug, appName, context, status, post],
  );
  // La voce di Alfred vive sopra il pannello: cambiare scheda o chiudere il pannello non la ferma; solo «Basta così» o
  // lasciare la pagina ospite (o scollegarsi)
  return (
    <AlfredVoiceProvider>
      <PanelProvider env={env}>
        <EmbedPanel host={host} status={status} open={open} />
      </PanelProvider>
    </AlfredVoiceProvider>
  );
}

function EmbedRoot() {
  const host = useHost();
  const [connected, setConnected] = useState(() => loadTokens() !== null);
  const connect = useConnect(host.clientId);

  useEffect(() => onTokensChange((t) => setConnected(t !== null)), []);
  // Lo spazio dei token è quello del client della pagina ospite: si sceglie appena la configurazione lo dà
  useLayoutEffect(() => {
    setEmbedClient(host.clientId);
    setConnected(loadTokens() !== null);
  }, [host.clientId]);
  useEffect(() => {
    if (!connected) queryClient.clear();
  }, [connected]);

  const retry = useCallback(() => host.retry(), [host]);

  if (host.unreachable) {
    return (
      <Centered>
        <Led state="ko" label={MESSAGES.unreachable} />
        <Button variant="secondary" onClick={retry}>
          Riprova
        </Button>
      </Centered>
    );
  }
  if (host.allowed === null) {
    return (
      <Centered>
        <Led state="work" label="Apertura di Botcave" />
      </Centered>
    );
  }
  if (!host.allowed || !host.clientId) {
    return (
      <Centered>
        <BotcaveMark />
        <Led state="ko" label={MESSAGES.hostNotAllowed} />
      </Centered>
    );
  }
  // Durante la verifica dell'utente si resta sulla schermata di collegamento
  if (connect.busy) return <ConnectScreen busy error={connect.error} onConnect={connect.connect} />;
  // Senza collegamento: con le segnalazioni attive il pannello del visitatore, altrimenti «Collega con Botcave»
  if (!connected) {
    if (!host.bugs.enabled) return <ConnectScreen busy={false} error={connect.error} onConnect={connect.connect} />;
    return (
      <VisitorBugsProvider host={host}>
        <VisitorPanel host={host} connectError={connect.error} onConnect={connect.connect} />
      </VisitorBugsProvider>
    );
  }
  return (
    <VisitorBugsProvider host={host}>
      <Shell host={host} />
    </VisitorBugsProvider>
  );
}

export function EmbedApp() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* I <Link> dei componenti della console aprono Botcave in una nuova scheda: l'iframe non naviga */}
      <Router hook={useEmbedLocation} hrefs={embedHrefs}>
        <TooltipProvider>
          <EmbedRoot />
          <Toaster />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>
  );
}
