import { CODE_WRITE_MESSAGES } from "./messages";

/** Controllo dei segreti prima di un commit (spec §7): solo prefissi noti e blocchi PEM, niente regola generica. */

export const COMMIT_LIMITS = {
  maxFiles: 50,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 5_242_880,
} as const;

const PREFIXES = [
  "sk-", "ghp_", "gho_", "ghs_", "github_pat_", "AKIA", "AIza", "xox[abp]-",
  "cas_", "cao_", "car_", "cat_", "whs_", "thu_",
];
const TOKEN_TAIL = "[A-Za-z0-9_\\-]{16,}";
const PEM = "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)";
const SOURCE = `${PEM}|(?<![A-Za-z0-9_])(?:${PREFIXES.join("|")})${TOKEN_TAIL}`;

export function findCredential(content: string): boolean {
  return new RegExp(SOURCE).test(content);
}

export function redactCredentials(text: string): string {
  return text.replace(new RegExp(SOURCE, "g"), "***");
}

/** null = commit ammissibile, altrimenti il messaggio fisso. `null` nella mappa = file eliminato. */
export function checkCommit(changes: Map<string, string | null>): string | null {
  if (changes.size === 0) return CODE_WRITE_MESSAGES.nothingToCommit;
  if (changes.size > COMMIT_LIMITS.maxFiles) return CODE_WRITE_MESSAGES.tooMany;
  let total = 0;
  for (const [path, content] of changes) {
    if (content === null) continue;
    if (content.includes("\0")) return CODE_WRITE_MESSAGES.binary(path);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > COMMIT_LIMITS.maxFileBytes) return CODE_WRITE_MESSAGES.tooLarge(path);
    total += bytes;
    if (total > COMMIT_LIMITS.maxTotalBytes) return CODE_WRITE_MESSAGES.tooLarge(path);
    if (findCredential(content)) return CODE_WRITE_MESSAGES.credential(path);
  }
  return null;
}
