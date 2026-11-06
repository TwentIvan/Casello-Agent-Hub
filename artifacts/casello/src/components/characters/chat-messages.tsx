import type { ReactNode } from "react";
import { AlfredMark, LuciusMark } from "@/components/brand/marks";
import { Markdown } from "@/components/plan/markdown";
import { cn } from "@/lib/utils";
import type { Character, ConvDetail, ProposalLike, ProposalRenderContext } from "./adapters";
import { CharacterProposalCard } from "./proposal-cards";

interface ChatMessagesProps {
  data: ConvDetail;
  character: Character;
  readOnly: boolean;
  deciding: boolean;
  /** Schede dei backend di oggi (piano, squadra); senza, le schede dei personaggi. */
  renderProposal?: (p: ProposalLike, ctx: ProposalRenderContext) => ReactNode;
  onDecide: (p: ProposalLike, decision: "accept" | "reject") => void;
  onHandoff: (p: ProposalLike) => void;
}

/** Messaggi della conversazione con le schede legate a ciascuna risposta. */
export function ChatMessages({ data, character, readOnly, deciding, renderProposal, onDecide, onHandoff }: ChatMessagesProps) {
  const name = character === "alfred" ? "Alfred" : "Lucius";
  const Mark = character === "alfred" ? AlfredMark : LuciusMark;
  return (
    <>
      {data.messages.map((m) => {
        const proposals = data.proposals.filter((p) => p.messageId === m.id);
        // Il segnaposto vuoto del turno in corso non è un messaggio da mostrare
        const empty = m.role === "assistant" && m.content === "";
        if (empty && proposals.length === 0) return null;
        return (
          <div key={m.id} className={cn("min-w-0 space-y-2", m.role === "user" && "flex flex-col items-end")}>
            {!empty && (
              <div
                className={cn(
                  "min-w-0 max-w-[90%] rounded-lg px-3 py-2",
                  m.role === "user" ? "bg-surface-2 text-ink" : "bg-muted",
                  m.error && "border border-destructive bg-destructive/10 text-destructive",
                )}
              >
                {m.role === "user" ? (
                  <p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>
                ) : (
                  <>
                    <p className="mb-1 flex items-center gap-2 text-label text-ink-muted">
                      <Mark size={12} />
                      {name}
                    </p>
                    <Markdown>{m.content}</Markdown>
                  </>
                )}
              </div>
            )}
            {proposals.length > 0 && (
              <div className="w-full min-w-0 space-y-2">
                {proposals.map((p) => {
                  const ctx = {
                    deciding,
                    readOnly,
                    decide: (decision: "accept" | "reject") => onDecide(p, decision),
                  };
                  return (
                    <div key={p.id} className="min-w-0">
                      {renderProposal ? (
                        renderProposal(p, ctx)
                      ) : (
                        <CharacterProposalCard
                          proposal={p}
                          subjectId={data.subjectId}
                          deciding={ctx.deciding}
                          readOnly={readOnly}
                          onDecide={ctx.decide}
                          onHandoff={() => onHandoff(p)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
