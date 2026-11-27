// Codice monouso e token del runner di collaudo: nel DB solo gli hash SHA-256, in chiaro solo nella risposta al claim.
// Il codice (15 minuti) lo consegna il lancio del job; lo scambio porta il collaudo da `dispatching` a `running`.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { appsTable, db, releaseTestsTable } from "@workspace/db";
import { githubConfig } from "../github/config";
import { installationToken } from "../github/app";
import { validateRecipe, type TestRecipe } from "./recipe";

export const CODE_TTL_MS = 15 * 60_000;
export const TOKEN_TTL_MS = 80 * 60_000;
export const LEASE_MS = 5 * 60_000;

export const COLLAUDO_TOKEN_PREFIX = "ctk_";

export type ClaimPackage = {
  token: string;
  repo: string;
  sha: string;
  repoToken: string;
  recipe: TestRecipe | null;
  mode: "full" | "relight";
};

/** Errore con stato HTTP e messaggio fisso (mai testo di GitHub). */
export class CollaudoProtocolError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CollaudoProtocolError";
  }
}

export const hashSecret = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Nuovo codice monouso per il collaudo (sostituisce il precedente); in chiaro solo qui. */
export async function issueCode(testId: number): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await db
    .update(releaseTestsTable)
    .set({ codeHash: hashSecret(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS) })
    .where(eq(releaseTestsTable.id, testId));
  return code;
}

/**
 * Scambia il codice con il token del collaudo e il pacchetto per il runner. Una volta sola: UPDATE condizionato a
 * `dispatching` e al codice non scaduto. Codice errato, scaduto o già usato → null.
 */
export async function claimTest(testId: number, code: string): Promise<ClaimPackage | null> {
  if (typeof code !== "string" || code.length < 16 || code.length > 200) return null;
  const codeHash = hashSecret(code);
  const now = new Date();
  const [row] = await db
    .select({
      sha: releaseTestsTable.sha,
      mode: releaseTestsTable.mode,
      repo: appsTable.sourceRepo,
      installationId: appsTable.sourceInstallationId,
      recipe: appsTable.testRecipe,
    })
    .from(releaseTestsTable)
    .innerJoin(appsTable, eq(appsTable.id, releaseTestsTable.appId))
    .where(
      and(
        eq(releaseTestsTable.id, testId),
        eq(releaseTestsTable.status, "dispatching"),
        eq(releaseTestsTable.codeHash, codeHash),
        gt(releaseTestsTable.codeExpiresAt, now),
      ),
    );
  if (!row) return null;
  if (!row.repo || !row.installationId) throw new CollaudoProtocolError(502, "accesso al repository non disponibile");
  const cfg = githubConfig();
  if (!cfg) throw new CollaudoProtocolError(502, "accesso al repository non disponibile");
  let repoToken: string;
  try {
    repoToken = await installationToken(cfg, row.installationId, { repo: row.repo, permissions: { contents: "read" } });
  } catch {
    throw new CollaudoProtocolError(502, "accesso al repository non disponibile");
  }

  const token = `${COLLAUDO_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const claimed = await db
    .update(releaseTestsTable)
    .set({
      status: "running",
      tokenHash: hashSecret(token),
      tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      startedAt: now,
      codeHash: null,
      codeExpiresAt: null,
    })
    .where(
      and(
        eq(releaseTestsTable.id, testId),
        eq(releaseTestsTable.status, "dispatching"),
        eq(releaseTestsTable.codeHash, codeHash),
        gt(releaseTestsTable.codeExpiresAt, now),
      ),
    )
    .returning({ id: releaseTestsTable.id });
  if (claimed.length === 0) return null;

  const parsed = row.recipe == null ? null : validateRecipe(row.recipe);
  return {
    token,
    repo: row.repo,
    sha: row.sha,
    repoToken,
    recipe: parsed && parsed.ok ? parsed.recipe : null,
    mode: row.mode,
  };
}
