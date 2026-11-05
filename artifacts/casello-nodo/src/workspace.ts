import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_INVALID = "spazio di lavoro non valido";

export class WorkspaceError extends Error {
  constructor() {
    super(WORKSPACE_INVALID);
    this.name = "WorkspaceError";
  }
}

/** Vero se `target` è `root` o sta sotto `root` (confronto con il separatore: `/root-evil` non è dentro `/root`). */
export function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

/**
 * Cartella di lavoro di un compito: `root` + `rel`. Rifiuta `rel` mancante, assoluto o con `..`, una cartella
 * inesistente e una che, risolti i link simbolici (`realpath` di radice e destinazione), esce dalla radice.
 */
export async function resolveWorkspace(root: string, rel: string | null): Promise<string> {
  if (rel === null || rel.trim() === "") throw new WorkspaceError();
  if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) throw new WorkspaceError();

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(path.resolve(realRoot, path.normalize(rel)));
  } catch {
    throw new WorkspaceError();
  }
  if (!isInside(realRoot, realTarget)) throw new WorkspaceError();
  const info = await stat(realTarget).catch(() => null);
  if (!info?.isDirectory()) throw new WorkspaceError();
  return realTarget;
}
