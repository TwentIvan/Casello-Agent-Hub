// Caricatore del pannello Botcave incorporabile: un solo file, nessuna dipendenza.
import { parseFromFrame, type EmbedTab, type HostContextMsg, type ToFrame } from "../protocol";
import { createOutbox } from "./queue";
import { readHostTheme } from "./read-theme";

const READY_TIMEOUT_MS = 10_000;
const MSG_DISABLED = "Questa app non è abilitata a Botcave";
const MSG_UNREACHABLE = "Botcave non risponde: riprova tra poco";

const CSS = `
:host { all: initial; }
.btn { position: fixed; bottom: 16px; width: 48px; height: 48px; padding: 0; border-radius: 50%;
  border: 1px solid hsl(var(--border, 0 0% 80%)); background: hsl(var(--background, 0 0% 100%));
  cursor: pointer; z-index: 2147483000; display: flex; align-items: center; justify-content: center; }
.btn[data-side="right"] { right: 16px; } .btn[data-side="left"] { left: 16px; }
.btn.inline { position: static; }
.btn img { width: 28px; height: 28px; display: block; }
.count { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
  border-radius: 9px; background: hsl(var(--primary, 0 0% 25%)); color: hsl(var(--primary-foreground, 0 0% 100%));
  font: 600 11px/18px sans-serif; text-align: center; }
.panel { position: fixed; top: 0; bottom: 0; width: 440px; max-width: 100%; display: none; z-index: 2147483001;
  background: hsl(var(--background, 0 0% 100%)); border: 0 solid hsl(var(--border, 0 0% 80%)); }
.panel[data-side="right"] { right: 0; border-left-width: 1px; } .panel[data-side="left"] { left: 0; border-right-width: 1px; }
.panel.open { display: block; }
@media (max-width: 640px) { .panel { width: 100%; border-width: 0 !important; } }
iframe { width: 100%; height: 100%; border: 0; display: block; }
.msg { padding: 24px; font: 14px/1.5 sans-serif; color: hsl(var(--foreground, 0 0% 10%)); }
`;

function start(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  const queue: Array<() => void> = [];
  let impl: { setContext(c: HostContextMsg): void; open(t?: EmbedTab): void; close(): void } | null = null;
  // L'oggetto globale esiste subito; le chiamate prima del montaggio si accodano.
  (window as unknown as { Botcave: unknown }).Botcave = {
    setContext: (c: HostContextMsg) => (impl ? impl.setContext(c) : queue.push(() => impl?.setContext(c))),
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

  const mount = () => {
    const host = document.createElement("div");
    const target = mountSel ? document.querySelector(mountSel) : null;
    (target ?? document.body).appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = target ? "btn inline" : "btn";
    btn.dataset.side = side;
    btn.title = "Botcave";
    btn.setAttribute("aria-label", "Botcave");
    const img = document.createElement("img");
    img.src = `${origin}/icon-192.png`;
    img.alt = "";
    btn.appendChild(img);
    const count = document.createElement("span");
    count.className = "count";
    count.hidden = true;
    btn.appendChild(count);
    shadow.appendChild(btn);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.side = side;
    shadow.appendChild(panel);

    let iframe: HTMLIFrameElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outbox = createOutbox((m: ToFrame) => iframe?.contentWindow?.postMessage(m, origin));

    const showMessage = (text: string) => {
      iframe?.remove();
      iframe = null;
      const p = document.createElement("div");
      p.className = "msg";
      p.textContent = text;
      panel.replaceChildren(p);
    };

    const sendTheme = () =>
      outbox.send({
        botcave: 1,
        type: "theme",
        payload: readHostTheme(
          document.documentElement,
          getComputedStyle,
          Array.from(document.querySelectorAll<HTMLLinkElement>("link[href]"), (l) => l.href),
        ),
      });

    const ensureFrame = () => {
      if (iframe) return;
      const f = document.createElement("iframe");
      f.title = "Botcave";
      f.allow = "microphone";
      f.src = `${origin}/embed?app=${encodeURIComponent(app)}&origin=${encodeURIComponent(location.origin)}`;
      iframe = f;
      panel.replaceChildren(f);
      sendTheme();
      timer = setTimeout(() => showMessage(MSG_DISABLED), READY_TIMEOUT_MS);
    };

    const setOpen = (open: boolean) => {
      panel.classList.toggle("open", open);
      if (open) ensureFrame();
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
        case "badge":
          count.hidden = m.payload.pending === 0;
          count.textContent = String(m.payload.pending);
          break;
        case "error":
          clearTimeout(timer);
          showMessage(m.payload.code === "unreachable" ? MSG_UNREACHABLE : MSG_DISABLED);
          break;
      }
    });

    btn.addEventListener("click", () => setOpen(!panel.classList.contains("open")));

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
  };

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

start();
