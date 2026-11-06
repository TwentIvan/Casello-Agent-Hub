// Riconosce testi che sembrano credenziali: la memoria non le conserva mai

const PREFIXES = ["sk-", "sk_", "ghp_", "gho_", "github_pat_", "cas_", "cao_", "car_", "AIza", "xox"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_CHARS = /^[A-Za-z0-9+/=_-]+$/;

export function looksLikeCredential(text: string): boolean {
  if (text.includes("-----BEGIN")) return true;
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (PREFIXES.some((p) => word.startsWith(p))) return true;
    // Token lungo senza spazi, con lettere e cifre (gli uuid non contano)
    if (UUID.test(word)) continue;
    if (word.length >= 32 && TOKEN_CHARS.test(word) && /[A-Za-z]/.test(word) && /[0-9]/.test(word)) return true;
  }
  return false;
}
