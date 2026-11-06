// Pagina /embed: il pannello di Botcave dentro l'iframe dell'app ospite.
// Accesso con il token `embed` (auth.ts), mai con il cookie di sessione; dialogo con l'ospite in use-host.ts.
import { useCallback, useEffect, useState } from "react";
import { QueryCache, QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { getCurrentUser, setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { BotcaveLogo, BotcaveMark } from "@/components/brand/marks";
import { Led } from "@/components/brand/led";
import { isClientError } from "@/lib/api-errors";
import { isUnauthorized } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { clearTokens, completeConnect, connectMessage, getAccessToken, loadTokens, onTokensChange, startConnect } from "./auth";
import { useHost } from "./use-host";
import { TAB_LABELS, TAB_ORDER, TabContent } from "./tab-content";
import type { EmbedTab } from "./protocol";

setBaseUrl(null);
setAuthTokenGetter(getAccessToken);

const MESSAGES = {
  popupBlocked: "Consenti i popup per questo sito e riprova",
  notEnabled: "Account non abilitato a Botcave",
  hostNotAllowed: "Questa app non è abilitata a Botcave",
  unreachable: "Botcave non risponde: riprova tra poco",
  failed: "Collegamento non completato: riprova",
} as const;

// Un 401 vuol dire token revocato o non più valido: si torna a «Collega con Botcave».
function onApiError(error: unknown) {
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

function Shell({
  host,
}: {
  host: ReturnType<typeof useHost>;
}) {
  const [tab, setTab] = useState<EmbedTab>("alfred");
  const { openRequest } = host;

  useEffect(() => {
    if (openRequest?.tab) setTab(openRequest.tab);
  }, [openRequest]);

  return (
    <div className="flex h-dvh flex-col bg-surface-1 text-ink">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <BotcaveMark className="h-5" />
        <nav role="tablist" aria-label="Schede di Botcave" className="flex min-w-0 flex-1 gap-1 overflow-hidden">
          {TAB_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "truncate rounded-sm px-2 py-1 text-label",
                tab === t ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink",
              )}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
        <Button variant="ghost" size="sm" onClick={() => host.post({ botcave: 1, type: "close" })}>
          Chiudi
        </Button>
      </header>
      <main role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-auto">
        <TabContent tab={tab} appSlug={host.appSlug} appName={host.appName} hostContext={host.context} />
      </main>
    </div>
  );
}

function EmbedRoot() {
  const host = useHost();
  const [connected, setConnected] = useState(() => loadTokens() !== null);
  const connect = useConnect(host.clientId);

  useEffect(() => onTokensChange((t) => setConnected(t !== null)), []);
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
  if (!connected || connect.busy) {
    return <ConnectScreen busy={connect.busy} error={connect.error} onConnect={connect.connect} />;
  }
  return <Shell host={host} />;
}

export function EmbedApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <EmbedRoot />
    </QueryClientProvider>
  );
}
