import { Link } from "wouter";
import type { TeamWork } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { workLed, workStatusLabel } from "@/lib/work-status";

const branchUrl = (repo: string, branch: string) => `https://github.com/${repo}/tree/${encodeURIComponent(branch).replace(/%2F/g, "/")}`;
const https = (u: string | null) => (u && /^https:\/\//.test(u) ? u : null);

/** Lavoro su branch unico nella carta «Piano»: branch, stato, PR unite, compito in fila, versione di prova e rilascio. */
export function WorkLine({ work }: { work: TeamWork }) {
  const staging = https(work.stagingUrl);
  const releasePr = https(work.releasePrUrl);
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Led state={workLed(work.status)} label={`Lavoro ${work.number} · ${workStatusLabel(work.status)}`} />
      </div>
      <p className="break-words">
        <a href={branchUrl(work.repo, work.branch)} target="_blank" rel="noopener" className="break-all font-mono text-xs hover:underline">
          {work.branch}
        </a>
        <span className="text-ink-muted">
          {" "}
          · {work.mergedPulls} PR unite
          {work.queuedTask && (
            <>
              {" "}
              · in fila <span className="font-mono">{work.queuedTask}</span>
            </>
          )}
        </span>
      </p>
      {(staging || work.stagingBranch) && work.status !== "released" && work.status !== "abandoned" && (
        <p className="text-ink-muted">
          Versione di prova:{" "}
          {staging ? (
            <a href={staging} target="_blank" rel="noopener" className="break-all text-ink hover:underline">
              {staging}
            </a>
          ) : (
            <span className="font-mono">{work.stagingBranch}</span>
          )}
        </p>
      )}
      {work.releaseActionNumber !== null && work.status === "awaiting_release" && (
        <p>
          <Link href="/pending-actions" className="text-accent-text underline">
            Porta in produzione: voce n. {work.releaseActionNumber} in «Da confermare»
          </Link>
        </p>
      )}
      {releasePr && (
        <p>
          <a href={releasePr} target="_blank" rel="noopener" className="font-mono text-xs hover:underline">
            PR di rilascio #{work.releasePrNumber}
          </a>
        </p>
      )}
      {work.postScripts.length > 0 && (
        <p className="break-words text-ink-muted">Script -post da applicare su Neon dopo il deploy: {work.postScripts.join(", ")}</p>
      )}
      {work.rejectionNote && work.status === "open" && <p className="whitespace-pre-wrap break-words text-danger">Rimandato alla squadra: {work.rejectionNote}</p>}
    </div>
  );
}
