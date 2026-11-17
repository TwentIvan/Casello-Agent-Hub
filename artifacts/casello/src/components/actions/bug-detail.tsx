import { Link } from "wouter";
import { readBugArgs } from "@/lib/bug-status";

const VERDICTS: Record<string, string> = {
  bug: "Sembra un bug",
  dettagli: "Servono dettagli",
  doppione: "Doppione",
  non_bug: "Non è un bug",
  inconcluso: "Inconcludente",
};

function Block({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="min-w-0">
      <p className="text-caption text-ink-muted">{label}</p>
      <p className="whitespace-pre-wrap break-words text-body-sm">{text}</p>
    </div>
  );
}

/** Segnalazione di un bug da un'app ospite: testo dell'utente, esito del vaglio del Responsabile e squadra designata. */
export function BugDetail({ args, linkTeam = true }: { args: unknown; linkTeam?: boolean }) {
  const b = readBugArgs(args);
  return (
    <div className="space-y-2 text-sm">
      <Block label="Titolo" text={b.title} />
      <Block label="Descrizione" text={b.description} />
      <Block label="Passi per riprodurlo" text={b.steps} />
      <Block label="Comportamento atteso" text={b.expected} />
      {b.triage && (
        <Block
          label={`Vaglio del Responsabile${VERDICTS[b.triage.verdict] ? ` · ${VERDICTS[b.triage.verdict]}` : ""}`}
          text={[b.triage.summary, b.triage.question && `Domanda: ${b.triage.question}`].filter(Boolean).join("\n")}
        />
      )}
      <p className="text-body-sm">
        <span className="text-caption text-ink-muted">Squadra per i bug: </span>
        {b.team ? (
          linkTeam ? (
            <Link href={`/teams/${b.team.id}`} className="underline underline-offset-2">
              {b.team.name}
            </Link>
          ) : (
            b.team.name
          )
        ) : (
          "nessuna: designa una squadra per i bug dalla sua scheda"
        )}
      </p>
    </div>
  );
}
