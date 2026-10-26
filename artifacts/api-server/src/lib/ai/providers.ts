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

/**
 * IPv4 non pubblici: 0.0.0.0/8, privati (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), loopback,
 * link-local, IETF (192.0.0.0/24), benchmark (198.18.0.0/15), multicast (224/4), riservati (240/4,
 * broadcast compreso).
 */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
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

/**
 * IPv6 non pubblici: non specificato, loopback, ULA (fc00::/7), link-local (fe80::/10), site-local
 * (fec0::/10), multicast (ff00::/8), IPv4 incorporati (::/96, ::ffff:0:0/96, SIIT ::ffff:0:0:0/96,
 * 64:ff9b::/96) che ricadono nelle regole IPv4, e i tunnel 6to4 (2002::/16) e Teredo (2001::/32).
 */
function isPrivateIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
  if ((g[0]! & 0xfe00) === 0xfc00) return true;
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  if ((g[0]! & 0xffc0) === 0xfec0) return true;
  if ((g[0]! & 0xff00) === 0xff00) return true;
  const embeddedV4 = () => `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  // ::a.b.c.d (IPv4-compatibile) e ::ffff:a.b.c.d (IPv4 mappato)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return isPrivateIpv4(embeddedV4());
  // ::ffff:0:a.b.c.d (SIIT)
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateIpv4(embeddedV4());
  // 64:ff9b::a.b.c.d (NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIpv4(embeddedV4());
  // 6to4 (2002::/16) e Teredo (2001:0::/32) incorporano un IPv4 (Teredo anche offuscato): scelta
  // semplice, si rifiutano per intero invece di decodificarlo. Nessun provider reale li usa.
  if (g[0] === 0x2002) return true;
  if (g[0] === 0x2001 && g[1] === 0) return true;
  return false;
}

/** Nomi che risolvono solo in rete interna: etichetta singola o suffissi riservati. */
function isInternalHostname(host: string): boolean {
  if (!host.includes(".")) return true;
  return [".localhost", ".local", ".internal"].some((suffix) => host.endsWith(suffix));
}

/**
 * Valida il base URL di un account: null se va bene, altrimenti il messaggio fisso "indirizzo non
 * consentito". Senza `allowPrivate` servono `https` e un host pubblico (niente nomi a etichetta
 * singola come `localhost`, suffissi `.localhost`/`.local`/`.internal`, né IP letterali non pubblici:
 * privati, CGNAT, loopback, link-local, multicast, IPv4 incorporati in IPv6); con `allowPrivate` (solo provider
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
  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host) ? BAD_URL_MESSAGE : null;
  if (kind === 6) return isPrivateIpv6(host) ? BAD_URL_MESSAGE : null;
  if (isInternalHostname(host)) return BAD_URL_MESSAGE;
  return null;
}
