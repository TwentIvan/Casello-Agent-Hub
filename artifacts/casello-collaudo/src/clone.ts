// Copia del codice dell'App allo sha del collaudo. Il token di lettura passa solo nell'ambiente del comando `git`
// (GIT_CONFIG_COUNT/KEY/VALUE: header `http.extraheader`), mai negli argomenti né su disco.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { safeEnv } from "./shell";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 5 * 60_000;

export const CLONE_MESSAGES = {
  invalid: "repository o sha non validi",
  failed: "copia del repository non riuscita",
} as const;

export type CloneOptions = { gitBase?: string };

/** Ambiente di git con l'header di autenticazione per GitHub. */
export function gitAuthEnv(repoToken: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${repoToken}`).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}

function git(args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(CLONE_MESSAGES.failed));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(CLONE_MESSAGES.failed));
    });
  });
}

/** `git init` + fetch dello sha con profondità 1 + checkout: equivale a `git clone --depth 1` allo sha. */
export async function cloneAt(repo: string, sha: string, repoToken: string, dir: string, opts: CloneOptions = {}): Promise<void> {
  if (!REPO.test(repo) || !SHA.test(sha)) throw new Error(CLONE_MESSAGES.invalid);
  const remote = `${opts.gitBase ?? "https://github.com"}/${repo}.git`;
  const plain = safeEnv();
  await mkdir(dir, { recursive: true });
  await git(["init", "-q", dir], plain);
  await git(["-C", dir, "fetch", "-q", "--depth", "1", "--no-tags", remote, sha], { ...plain, ...gitAuthEnv(repoToken) });
  await git(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], plain);
}
