// Comandi `browser` del collaudatore: un Chromium di Playwright con un contesto che registra il video.
// `playwright` si importa a runtime (lo installa il workflow): i test usano un BrowserDriver finto.

import { readFile } from "node:fs/promises";

export const SNAPSHOT_MAX = 12_000;
const ACTION_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 1_000;
const ERROR_MAX = 1_000;

export interface BrowserDriver {
  open(url: string): Promise<string>;
  click(sel: string): Promise<string>;
  fill(sel: string, text: string): Promise<string>;
  press(key: string): Promise<string>;
  snapshot(): Promise<string>;
  screenshot(): Promise<Buffer>;
  wait(ms: number): Promise<string>;
  /** `wait` con un selettore o un testo atteso (come lo descrive lo strumento del collaudatore). */
  waitFor(selector: string | undefined, text: string | undefined): Promise<string>;
  close(): Promise<{ video: Buffer | null }>;
}

export const BROWSER_MESSAGES = {
  invalid: "argomenti non validi: action tra open, click, fill, press, snapshot, screenshot, wait",
  needUrl: "open vuole url",
  needSelector: (action: string) => `${action} vuole selector`,
  needText: (action: string) => `${action} vuole text`,
  badUrl: "indirizzo non valido",
  failed: (action: string, detail: string) => `${action} non riuscito: ${detail}`,
  uploadFailed: "screenshot non caricato su Botcave",
} as const;

export function clipSnapshot(text: string): string {
  return text.length <= SNAPSHOT_MAX ? text : text.slice(0, SNAPSHOT_MAX);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- tipi di Playwright non disponibili a tempo di compilazione */
export async function playwrightDriver(videoDir: string): Promise<BrowserDriver> {
  const moduleName = "playwright";
  const pw: any = await import(moduleName);
  const browser: any = await pw.chromium.launch();
  const context: any = await browser.newContext({ recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }, viewport: { width: 1280, height: 720 } });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const page: any = await context.newPage();
  return {
    async open(url) {
      const res: any = await page.goto(url, { waitUntil: "load" });
      return `aperta ${page.url()}${res ? ` (HTTP ${res.status()})` : ""}, titolo: ${await page.title()}`;
    },
    async click(sel) {
      await page.click(sel);
      return `clic su ${sel}; pagina: ${page.url()}`;
    },
    async fill(sel, text) {
      await page.fill(sel, text);
      return `compilato ${sel}`;
    },
    async press(key) {
      await page.keyboard.press(key);
      return `premuto ${key}; pagina: ${page.url()}`;
    },
    async snapshot() {
      const tree: string = await page.locator("body").ariaSnapshot();
      return clipSnapshot(`pagina: ${page.url()}\n${tree}`);
    },
    async screenshot() {
      return Buffer.from(await page.screenshot({ type: "png" }));
    },
    async wait(ms) {
      await page.waitForTimeout(ms);
      return `atteso ${ms} ms`;
    },
    async waitFor(selector, text) {
      if (selector) await page.waitForSelector(selector);
      if (text) await page.getByText(text).first().waitFor();
      return `trovato ${selector ?? text}`;
    },
    async close() {
      const video: any = page.video();
      await context.close();
      let bytes: Buffer | null = null;
      if (video) {
        try {
          bytes = await readFile(await video.path());
        } catch {
          bytes = null;
        }
      }
      await browser.close();
      return { video: bytes };
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type BrowserContext = {
  driver: () => Promise<BrowserDriver>;
  /** Base per gli indirizzi relativi (l'App avviata sul runner). */
  baseUrl: () => string;
  uploadScreenshot: (png: Buffer) => Promise<number>;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function errorDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : "errore sconosciuto";
  return msg.length > ERROR_MAX ? `${msg.slice(0, ERROR_MAX)}…` : msg;
}

/** Esegue un comando `browser`; per `screenshot` il risultato è l'id del file caricato su Botcave. */
export async function runBrowser(args: Record<string, unknown>, ctx: BrowserContext): Promise<{ ok: boolean; output: string }> {
  const action = str(args.action);
  const url = str(args.url);
  const selector = str(args.selector);
  const text = typeof args.text === "string" ? args.text : undefined;
  let target: string | null = null;
  switch (action) {
    case "open": {
      if (!url) return { ok: false, output: BROWSER_MESSAGES.needUrl };
      try {
        target = new URL(url, ctx.baseUrl()).toString();
      } catch {
        return { ok: false, output: BROWSER_MESSAGES.badUrl };
      }
      if (!/^https?:$/.test(new URL(target).protocol)) return { ok: false, output: BROWSER_MESSAGES.badUrl };
      break;
    }
    case "click":
      if (!selector) return { ok: false, output: BROWSER_MESSAGES.needSelector(action) };
      break;
    case "fill":
      if (!selector) return { ok: false, output: BROWSER_MESSAGES.needSelector(action) };
      if (text === undefined) return { ok: false, output: BROWSER_MESSAGES.needText(action) };
      break;
    case "press":
      if (!text) return { ok: false, output: BROWSER_MESSAGES.needText(action) };
      break;
    case "snapshot":
    case "screenshot":
    case "wait":
      break;
    default:
      return { ok: false, output: BROWSER_MESSAGES.invalid };
  }
  try {
    const d = await ctx.driver();
    switch (action) {
      case "open":
        return { ok: true, output: await d.open(target!) };
      case "click":
        return { ok: true, output: await d.click(selector!) };
      case "fill":
        return { ok: true, output: await d.fill(selector!, text!) };
      case "press":
        return { ok: true, output: await d.press(text!) };
      case "snapshot":
        return { ok: true, output: clipSnapshot(await d.snapshot()) };
      case "screenshot": {
        const png = await d.screenshot();
        try {
          return { ok: true, output: String(await ctx.uploadScreenshot(png)) };
        } catch (err) {
          if (err instanceof Error && err.name === "CollaudoClosedError") throw err;
          return { ok: false, output: BROWSER_MESSAGES.uploadFailed };
        }
      }
      default: {
        // wait: un testo numerico (o nessun argomento) è un'attesa in millisecondi, altrimenti selettore o testo atteso
        const ms = text !== undefined && /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
        if (selector || (text !== undefined && ms === undefined)) return { ok: true, output: await d.waitFor(selector, text) };
        return { ok: true, output: await d.wait(Math.min(ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS)) };
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "CollaudoClosedError") throw err;
    return { ok: false, output: BROWSER_MESSAGES.failed(action, errorDetail(err)) };
  }
}
