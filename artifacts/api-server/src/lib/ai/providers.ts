import { isIP } from "node:net";
import type { aiProviderEnum } from "@workspace/db";

/**
 * Provider AI compatibili OpenAI (`/models`, `/chat/completions`) e validazione del loro base URL.
 * Modulo puro: niente DB né rete.
 */

export type AiProvider = (typeof aiProviderEnum.enumValues)[number];

export interface ProviderInfo {
  label: string;
  /** Base URL predefinito; null se lo inserisce l'utente (custom) o arriva dall'ambiente (system_gateway). */
  defaultBaseUrl: string | null;
  editableBaseUrl: boolean;
}

export const PROVIDERS: Record<AiProvider, ProviderInfo> = {
  deepseek: { label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com/v1", editableBaseUrl: false },
  openrouter: { label: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", editableBaseUrl: false },
  huggingface: { label: "Hugging Face", defaultBaseUrl: "https://router.huggingface.co/v1", editableBaseUrl: false },
  mistral: { label: "Mistral", defaultBaseUrl: "https://api.mistral.ai/v1", editableBaseUrl: false },
  groq: { label: "Groq", defaultBaseUrl: "https://api.groq.com/openai/v1", editableBaseUrl: false },
  together: { label: "Together AI", defaultBaseUrl: "https://api.together.xyz/v1", editableBaseUrl: false },
  custom: { label: "Personalizzato (compatibile OpenAI)", defaultBaseUrl: null, editableBaseUrl: true },
  // Il base URL viene da AI_GATEWAY_BASE_URL (account di sistema della transizione)
  system_gateway: { label: "Gateway di Casello", defaultBaseUrl: null, editableBaseUrl: false },
};

export const BAD_URL_MESSAGE = "indirizzo non consentito";

/** Toglie spazi e barre finali: `https://x/v1/` → `https://x/v1`. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** IPv4 in loopback, privati, link-local o 0.0.0.0/8. */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Espande un IPv6 in 8 gruppi da 16 bit; null se non è valido. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  // Coda IPv4 (es. ::ffff:1.2.3.4) → due gruppi esadecimali
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":").map((g) => parseInt(g, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff) ? null : groups;
}

/** IPv6 non specificato, loopback, ULA (fc00::/7), link-local (fe80::/10) o IPv4 mappato privato. */
function isPrivateIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
  if ((g[0]! & 0xfe00) === 0xfc00) return true;
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  // ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPrivateIpv4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  }
  return false;
}

/**
 * Valida il base URL di un account: null se va bene, altrimenti il messaggio fisso "indirizzo non
 * consentito". Senza `allowPrivate` servono `https` e un host pubblico (niente `localhost`,
 * `*.localhost` né IP letterali privati, loopback o link-local); con `allowPrivate` (solo provider
 * custom con `allow_private_network`) sono ammessi anche `http` e gli indirizzi privati.
 * Credenziali, query e frammento non sono mai ammessi.
 *
 * Nessuna risoluzione DNS: un nome pubblico che risolve verso un IP privato non viene bloccato qui
 * (fuori dallo scopo di questa validazione).
 */
export function validateBaseUrl(url: string, allowPrivate: boolean): string | null {
  let u: URL;
  try {
    u = new URL(normalizeBaseUrl(url));
  } catch {
    return BAD_URL_MESSAGE;
  }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) return BAD_URL_MESSAGE;
  if (u.username || u.password || u.search || u.hash) return BAD_URL_MESSAGE;
  if (!u.hostname) return BAD_URL_MESSAGE;
  if (allowPrivate) return null;

  // Il parser WHATWG normalizza già gli IPv4 (es. 0x7f000001 → 127.0.0.1) e mette gli IPv6 tra []
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return BAD_URL_MESSAGE;
  const kind = isIP(host);
  if (kind === 4 && isPrivateIpv4(host)) return BAD_URL_MESSAGE;
  if (kind === 6 && isPrivateIpv6(host)) return BAD_URL_MESSAGE;
  return null;
}
