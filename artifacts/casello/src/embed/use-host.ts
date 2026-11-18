// Dialogo con la pagina ospite: verifica dell'origine con GET /api/embed/config, messaggi postMessage
// accettati solo da window.parent con l'origine della query e solo se l'origine è ammessa, tema applicato
// con setProperty sulle variabili di <html> (mai testo CSS o HTML costruito con i dati dell'ospite).
import { useCallback, useEffect, useRef, useState } from "react";
import { getEmbedConfig } from "@workspace/api-client-react";
import { parseToFrame, type EmbedTab, type FromFrame, type HostContextMsg, type HostTheme } from "./protocol";
import { cleanFontUrl, themeToCss } from "./theme";
import { cleanAppSlug } from "./panel-helpers";

export type HostOpenRequest = { tab?: EmbedTab; focusContext?: true; seq: number };

/** Attesa massima della risposta a `identity_request`. */
const IDENTITY_WAIT_MS = 5_000;

export type HostState = {
  /** null finché la configurazione non è letta. */
  allowed: boolean | null;
  /** Botcave non ha risposto alla lettura della configurazione. */
  unreachable: boolean;
  clientId: string | null;
  appName: string | null;
  appSlug: string;
  /** Origine della pagina ospite (dalla query, già validata), o null. */
  origin: string | null;
  /** Segnalazioni dei bug dell'App: attive e con l'identità degli utenti configurata. */
  bugs: { enabled: boolean; identity: boolean };
  /** Ultimo token d'identità mandato dalla pagina ospite (`identity`), o null. */
  identity: string | null;
  /** La pagina ospite ha mandato almeno un messaggio `identity` (anche con token null). */
  identityReceived: boolean;
  theme: HostTheme | null;
  context: HostContextMsg | null;
  /** Ultima richiesta `open` della pagina ospite (seq cresce a ogni richiesta). */
  openRequest: HostOpenRequest | null;
  post(m: FromFrame): void;
  retry(): void;
  /** Chiede alla pagina ospite un'identità nuova: risolve al prossimo `identity` o dopo 5 s con quella attuale. */
  requestIdentity(): Promise<string | null>;
};

const FONT_LINK_ID = "botcave-host-font";

/** Origine valida (`https://host[:porta]` o `http://…` in sviluppo), altrimenti null. */
function cleanOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

function readQuery(): { appSlug: string; origin: string | null } {
  const q = new URLSearchParams(window.location.search);
  return { appSlug: cleanAppSlug(q.get("app")), origin: cleanOrigin(q.get("origin")) };
}

let appliedVars: string[] = [];

function applyTheme(theme: HostTheme): void {
  const root = document.documentElement;
  const css = themeToCss(theme);
  for (const name of appliedVars) if (!(name in css)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(css)) root.style.setProperty(name, value);
  appliedVars = Object.keys(css);
  root.setAttribute("data-theme", theme.mode);

  const href = cleanFontUrl(theme.fontUrl);
  const existing = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
  if (!href) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.href !== href) existing.href = href;
    return;
  }
  const link = document.createElement("link");
  link.id = FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export function useHost(): HostState {
  const [{ appSlug, origin }] = useState(readQuery);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [appName, setAppName] = useState<string | null>(null);
  const [theme, setTheme] = useState<HostTheme | null>(null);
  const [context, setContext] = useState<HostContextMsg | null>(null);
  const [openRequest, setOpenRequest] = useState<HostOpenRequest | null>(null);
  const [bugs, setBugs] = useState<HostState["bugs"]>({ enabled: false, identity: false });
  const [identity, setIdentity] = useState<string | null>(null);
  const [identityReceived, setIdentityReceived] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const allowedRef = useRef(false);
  const identityRef = useRef<string | null>(null);
  const identityWaiters = useRef<((token: string | null) => void)[]>([]);

  const post = useCallback(
    (m: FromFrame) => {
      if (!origin || window.parent === window) return;
      window.parent.postMessage(m, origin);
    },
    [origin],
  );

  // Configurazione: l'origine della pagina ospite è nella lista ammessa?
  useEffect(() => {
    let cancelled = false;
    setUnreachable(false);
    setAllowed(null);
    allowedRef.current = false;
    if (!origin) {
      setAllowed(false);
      post({ botcave: 1, type: "error", payload: { code: "host_not_allowed" } });
      return;
    }
    getEmbedConfig(appSlug ? { origin, app: appSlug } : { origin })
      .then((cfg) => {
        if (cancelled) return;
        const ok = cfg.allowed && cfg.clientId !== null;
        allowedRef.current = ok;
        setAllowed(ok);
        setClientId(cfg.clientId);
        setAppName(cfg.appName);
        setBugs({ enabled: ok && cfg.bugs.enabled, identity: ok && cfg.bugs.identity });
        post(ok ? { botcave: 1, type: "ready" } : { botcave: 1, type: "error", payload: { code: "host_not_allowed" } });
      })
      .catch(() => {
        if (cancelled) return;
        setUnreachable(true);
        post({ botcave: 1, type: "error", payload: { code: "unreachable" } });
      });
    return () => {
      cancelled = true;
    };
  }, [origin, appSlug, post, attempt]);

  // Messaggi della pagina ospite: solo dal genitore, dalla sua origine e se ammessa; il resto si ignora.
  useEffect(() => {
    if (!origin) return;
    let seq = 0;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== origin || !allowedRef.current) return;
      const msg = parseToFrame(event.data);
      if (!msg) return;
      switch (msg.type) {
        case "theme":
          applyTheme(msg.payload);
          setTheme(msg.payload);
          break;
        case "context":
          setContext(msg.payload);
          break;
        case "open":
          seq += 1;
          setOpenRequest({ ...msg.payload, seq });
          break;
        case "identity": {
          const token = msg.payload.token;
          identityRef.current = token;
          setIdentity(token);
          setIdentityReceived(true);
          const waiters = identityWaiters.current;
          identityWaiters.current = [];
          for (const resolve of waiters) resolve(token);
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const requestIdentity = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        let done = false;
        const finish = (token: string | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          identityWaiters.current = identityWaiters.current.filter((w) => w !== finish);
          resolve(token);
        };
        const timer = setTimeout(() => finish(identityRef.current), IDENTITY_WAIT_MS);
        identityWaiters.current.push(finish);
        post({ botcave: 1, type: "identity_request" });
      }),
    [post],
  );

  return {
    allowed,
    unreachable,
    clientId,
    appName,
    appSlug,
    origin,
    bugs,
    identity,
    identityReceived,
    theme,
    context,
    openRequest,
    post,
    retry,
    requestIdentity,
  };
}
