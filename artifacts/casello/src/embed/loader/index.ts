// Caricatore del pannello Botcave incorporabile: un solo file, nessuna dipendenza.
// Pulsante a pillola con lo stato mandato dall'iframe (`status`); l'iframe nasce nascosto appena il browser è libero
// (al più 3 s dopo il caricamento), così il pulsante mostra contatori e LED prima del primo clic.
import { contextMessage, parseFromFrame, type EmbedTab, type HostContextMsg, type StatusPayload, type ToFrame } from "../protocol";
import { LED_ON, ON_LED } from "./brand-colors";
import { IDLE_STATUS, pillView } from "./pill";
import { IDENTITY_MIN_INTERVAL_MS, createRequestGate, fetchIdentity, identityPath, refreshDelayMs, tokenExpiry } from "./identity";
import { createOutbox } from "./queue";
import { readHostTheme } from "./read-theme";
import { themeToCss } from "../theme";

const READY_TIMEOUT_MS = 10_000;
const MSG_DISABLED = "Questa app non è abilitata a Botcave";
const MSG_UNREACHABLE = "Botcave non risponde: riprova tra poco";

const EARLY_FRAME_MS = 3_000;
const NARROW_QUERY = "(max-width: 640px)";

// Niente ombre; colori dal tema della pagina ospite (variabili --surface-*) e, per LED e contatore, quelli di Botcave
const CSS = `
:host { all: initial; --botcave-led: ${LED_ON}; --botcave-on-led: ${ON_LED}; }
.btn { position: fixed; bottom: 16px; height: 40px; padding: 0 14px 0 10px; box-sizing: border-box; border-radius: 20px;
  border: 1px solid var(--surface-border, hsl(0 0% 80%)); background: var(--surface-bg, hsl(0 0% 100%));
  color: var(--surface-fg, hsl(0 0% 10%)); font: 500 14px/1 var(--surface-font, system-ui, sans-serif);
  cursor: pointer; z-index: 2147483000; display: flex; align-items: center; gap: 8px; }
.btn[data-side="right"] { right: 16px; } .btn[data-side="left"] { left: 16px; }
.btn.inline { position: relative; }
.btn img { width: 24px; height: 24px; display: block; flex-shrink: 0; }
.label { white-space: nowrap; }
.label:empty { display: none; }
.led { width: 8px; height: 8px; flex-shrink: 0; background: var(--botcave-led); }
.led[data-state="work"] { animation: botcave-pulse 2.4s ease-in-out infinite; }
.led[data-state="ask"] { animation: botcave-blink 1s steps(2, jump-none) infinite; }
@keyframes botcave-pulse { 50% { opacity: 0.35; } }
@keyframes botcave-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .led[data-state] { animation: none; } }
.count { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
  background: var(--botcave-led); color: var(--botcave-on-led); font: 500 11px/18px ui-monospace, Menlo, monospace; text-align: center; }
@media ${NARROW_QUERY} {
  .btn { width: 48px; height: 48px; padding: 0; border-radius: 50%; justify-content: center; }
  .btn img { width: 28px; height: 28px; }
  .led { position: absolute; bottom: 6px; right: 6px; }
}
.panel { position: fixed; top: 0; bottom: 0; width: 440px; max-width: 100%; display: none; z-index: 2147483001;
  background: var(--surface-bg, hsl(0 0% 100%)); border: 0 solid var(--surface-border, hsl(0 0% 80%)); }
.panel[data-side="right"] { right: 0; border-left-width: 1px; } .panel[data-side="left"] { left: 0; border-right-width: 1px; }
.panel.open { display: block; }
@media ${NARROW_QUERY} { .panel { width: 100%; border-width: 0 !important; } }
iframe { width: 100%; height: 100%; border: 0; display: block; }
.msg button { margin-top: 12px; display: block; padding: 6px 12px; cursor: pointer; font: inherit; color: var(--surface-fg, hsl(0 0% 10%)); background: var(--surface-bg, hsl(0 0% 100%)); border: 1px solid var(--surface-border, hsl(0 0% 80%)); border-radius: 6px; }
.msg { padding: 24px; font: 14px/1.5 sans-serif; color: var(--surface-fg, hsl(0 0% 10%)); }
`;

function start(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  const queue: Array<() => void> = [];
  let impl: { setContext(c: HostContextMsg): void; open(t?: EmbedTab): void; close(): void } | null = null;
  // L'oggetto globale esiste subito; le chiamate prima del montaggio si accodano.
  (window as unknown as { Botcave: unknown }).Botcave = {
    // Contesto validato subito, come lo valida l'iframe: uno non valido non si manda e si avvisa in console
    setContext: (c: HostContextMsg) => {
      const msg = contextMessage(c);
      if (!msg) {
        console.warn("Botcave: setContext ignorato, contesto non valido (page obbligatoria; page e id [A-Za-z0-9._:-] fino a 40 caratteri, title fino a 200 su una riga)");
        return;
      }
      if (impl) impl.setContext(msg.payload);
      else queue.push(() => impl?.setContext(msg.payload));
    },
    open: (t?: EmbedTab) => (impl ? impl.open(t) : queue.push(() => impl?.open(t))),
    close: () => (impl ? impl.close() : queue.push(() => impl?.close())),
  };

  const app = script?.dataset.app;
  if (!script || !script.src) return;
  if (!app) {
    console.warn("Botcave: manca l'attributo data-app sullo script, il pulsante non viene mostrato");
    return;
  }
  const origin = new URL(script.src).origin;
  const side = script.dataset.position === "left" ? "left" : "right";
  const mountSel = script.dataset.mount;
  const rawIdentity = script.dataset.identityUrl;
  const identityUrl = identityPath(rawIdentity);
  if (rawIdentity !== undefined && !identityUrl) {
    console.warn("Botcave: data-identity-url ignorato, serve un percorso che inizia con / (non //), fino a 500 caratteri");
  }

  const mount = () => {
    const host = document.createElement("div");
    let target: Element | null = null;
    if (mountSel) {
      try {
        target = document.querySelector(mountSel);
      } catch {
        console.warn("Botcave: data-mount non è un selettore valido, il pulsante va nel body");
      }
    }
    (target ?? document.body).appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = target ? "btn inline" : "btn";
    btn.dataset.side = side;
    const img = document.createElement("img");
    img.src = `${origin}/icon-192.png`;
    img.alt = "";
    btn.appendChild(img);
    const label = document.createElement("span");
    label.className = "label";
    btn.appendChild(label);
    const led = document.createElement("span");
    led.className = "led";
    led.hidden = true;
    btn.appendChild(led);
    const count = document.createElement("span");
    count.className = "count";
    count.hidden = true;
    btn.appendChild(count);
    shadow.appendChild(btn);

    // Aspetto del pulsante: stato dell'iframe e larghezza della finestra (sotto i 640 px solo il segno)
    let status: StatusPayload = IDLE_STATUS;
    const narrowQuery = window.matchMedia?.(NARROW_QUERY) ?? null;
    const renderPill = () => {
      const view = pillView(status, narrowQuery?.matches ?? false);
      label.textContent = view.label;
      led.hidden = view.led === null;
      if (view.led) led.dataset.state = view.led;
      else delete led.dataset.state;
      count.hidden = view.count === null;
      count.textContent = view.count === null ? "" : String(view.count);
      const extra = [
        status.actions > 0 ? (status.actions === 1 ? "1 azione" : `${status.actions} azioni`) : null,
        view.count !== null ? `${view.count} da vedere` : null,
        view.led === "work" ? "al lavoro" : view.led === "ask" ? "risposta da leggere" : null,
      ].filter(Boolean);
      const name = extra.length > 0 ? `Botcave: ${extra.join(", ")}` : "Botcave";
      btn.title = name;
      btn.setAttribute("aria-label", name);
    };
    narrowQuery?.addEventListener?.("change", renderPill);
    renderPill();

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.side = side;
    shadow.appendChild(panel);

    let iframe: HTMLIFrameElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Errore definitivo dell'iframe (app non ammessa, Botcave non raggiungibile): il messaggio resta finché non si riprova
    let failed = false;
    const outbox = createOutbox((m: ToFrame) => iframe?.contentWindow?.postMessage(m, origin));

    const showMessage = (text: string, retry: boolean, sticky = true) => {
      clearTimeout(timer);
      failed = sticky;
      status = IDLE_STATUS;
      renderPill();
      iframe?.remove();
      iframe = null;
      clearTimeout(identityTimer);
      const p = document.createElement("div");
      p.className = "msg";
      p.textContent = text;
      if (retry) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Riprova";
        b.addEventListener("click", () => {
          failed = false;
          ensureFrame();
        });
        p.appendChild(b);
      }
      panel.replaceChildren(p);
    };

    // Variabili del guscio dal tema ospite già filtrato; HSL shadcn convertito come in themeToCss.
    const applyShellVars = (theme: ReturnType<typeof readHostTheme>) => {
      const css = themeToCss(theme);
      const dark = theme.mode === "dark";
      if (css["--font-sans"]) host.style.setProperty("--surface-font", css["--font-sans"]);
      else host.style.removeProperty("--surface-font");
      const set = (name: string, key: string, fallback: string) =>
        host.style.setProperty(name, css[key] ?? fallback);
      set("--surface-bg", "--surface-1", dark ? "hsl(0 0% 12%)" : "hsl(0 0% 100%)");
      set("--surface-fg", "--ink", dark ? "hsl(0 0% 95%)" : "hsl(0 0% 10%)");
      set("--surface-border", "--border", dark ? "hsl(0 0% 30%)" : "hsl(0 0% 80%)");
      set("--surface-accent", "--accent", dark ? "hsl(0 0% 80%)" : "hsl(0 0% 25%)");
      set("--surface-on-accent", "--on-accent", dark ? "hsl(0 0% 10%)" : "hsl(0 0% 100%)");
    };

    const readTheme = () =>
      readHostTheme(
        document.documentElement,
        getComputedStyle,
        Array.from(document.querySelectorAll<HTMLLinkElement>("link[href]"), (l) => l.href),
      );
    applyShellVars(readTheme());

    const sendTheme = () => {
      const theme = readTheme();
      applyShellVars(theme);
      outbox.send({ botcave: 1, type: "theme", payload: theme });
    };

    // Identità: richiesta all'apertura, a ogni identity_request e prima della scadenza del token.
    let identityTimer: ReturnType<typeof setTimeout> | undefined;
    let identityBusy = false;
    const gate = createRequestGate(IDENTITY_MIN_INTERVAL_MS);
    // `force` solo per il giro pianificato dal timer; apertura e identity_request rispettano l'intervallo minimo.
    const refreshIdentity = async (force = false) => {
      if (!identityUrl || identityBusy || !gate.allow(force)) return;
      identityBusy = true;
      try {
        const token = await fetchIdentity(identityUrl);
        clearTimeout(identityTimer);
        if (!iframe) return;
        outbox.send({ botcave: 1, type: "identity", payload: { token } });
        const delay = token ? refreshDelayMs(tokenExpiry(token), Date.now()) : null;
        if (delay !== null) identityTimer = setTimeout(() => void refreshIdentity(true), delay);
      } finally {
        identityBusy = false;
      }
    };

    const ensureFrame = () => {
      if (iframe) return;
      const f = document.createElement("iframe");
      f.title = "Botcave";
      f.allow = "microphone";
      f.src = `${origin}/embed?app=${encodeURIComponent(app)}&origin=${encodeURIComponent(location.origin)}`;
      iframe = f;
      outbox.reset();
      panel.replaceChildren(f);
      sendTheme();
      // Senza «ready» in tempo: messaggio nel pannello (visibile solo aperto); il clic successivo riprova
      timer = setTimeout(() => showMessage(MSG_DISABLED, false, false), READY_TIMEOUT_MS);
      // L'identità del visitatore si chiede alla pagina ospite solo con il pannello aperto (o su richiesta dell'iframe)
      if (panel.classList.contains("open")) void refreshIdentity(true);
    };

    const setOpen = (open: boolean) => {
      panel.classList.toggle("open", open);
      if (open) {
        if (iframe) void refreshIdentity();
        else if (!failed) ensureFrame();
      }
    };

    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.origin !== origin || !iframe || ev.source !== iframe.contentWindow) return;
      const m = parseFromFrame(ev.data);
      if (!m) return;
      switch (m.type) {
        case "ready":
          clearTimeout(timer);
          outbox.ready();
          break;
        case "close":
          setOpen(false);
          break;
        case "identity_request":
          void refreshIdentity();
          break;
        case "status":
          status = m.payload;
          renderPill();
          break;
        case "error":
          if (m.payload.code === "unreachable") showMessage(MSG_UNREACHABLE, true);
          else showMessage(MSG_DISABLED, false);
          break;
      }
    });

    btn.addEventListener("click", () => {
      const opening = !panel.classList.contains("open");
      setOpen(opening);
      // Con azioni sulla pagina il pannello si apre con la barra del contesto in vista
      if (opening && status.actions > 0) outbox.send({ botcave: 1, type: "open", payload: { focusContext: true } });
    });

    new MutationObserver(sendTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    impl = {
      setContext: (c) => outbox.send({ botcave: 1, type: "context", payload: c }),
      open: (tab) => {
        setOpen(true);
        outbox.send({ botcave: 1, type: "open", payload: tab ? { tab } : {} });
      },
      close: () => setOpen(false),
    };
    for (const fn of queue.splice(0)) fn();

    // Iframe anticipato e nascosto, appena il browser è libero (al più dopo 3 s)
    const early = () => {
      if (!iframe && !failed) ensureFrame();
    };
    const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle.call(window, early, { timeout: EARLY_FRAME_MS });
    else setTimeout(early, EARLY_FRAME_MS);
  };

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

start();
