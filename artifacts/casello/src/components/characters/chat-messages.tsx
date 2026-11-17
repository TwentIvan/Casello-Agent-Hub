import type { ReactNode } from "react";
import { Markdown } from "@/components/plan/markdown";
import { cn } from "@/lib/utils";
import type { Character, ConvDetail, ProposalLike, ProposalRenderContext } from "./adapters";
import { CharacterMark } from "./character-mark";
import type { CharacterInstructionProposal } from "@workspace/api-client-react";
import { InstructionProposalCard } from "./instruction-proposal-card";
import { CharacterProposalCard } from "./proposal-cards";
import { CHARACTER_TEXT } from "./targets";

interface ChatMessagesProps {
  data: ConvDetail;
  character: Character;
  readOnly: boolean;
  deciding: boolean;
  /** Schede dei backend di oggi (piano, squadra); senza, le schede dei personaggi. */
  renderProposal?: (p: ProposalLike, ctx: ProposalRenderContext) => ReactNode;
  onDecide: (p: ProposalLike, decision: "accept" | "reject") => void;
  onHandoff: (p: ProposalLike) => void;
  /** Schede delle istruzioni personali già raggruppate per messaggio (`proposalsByMessage`). */
  instructionProposals?: { byMessage: Map<number, CharacterInstructionProposal[]>; trailing: CharacterInstructionProposal[] };
  onInstructionDecided?: () => void;
}

/** Messaggi della conversazione con le schede legate a ciascuna risposta. */
export function ChatMessages({
  data, character, readOnly, deciding, renderProposal,
  onDecide,
  onHandoff,
  instructionProposals,
  onInstructionDecided,
}: ChatMessagesProps) {
  const name = CHARACTER_TEXT[character].name;
  const renderInstruction = (p: CharacterInstructionProposal) => (
    <div key={`i${p.id}`} className="min-w-0">
      <InstructionProposalCard proposal={p} readOnly={readOnly} onDecided={() => onInstructionDecided?.()} />
    </div>
  );
  return (
    <>
      {data.messages.map((m) => {
        const proposals = data.proposals.filter((p) => p.messageId === m.id);
        const instructions = instructionProposals?.byMessage.get(m.id) ?? [];
        // Il segnaposto vuoto del turno in corso non è un messaggio da mostrare
        const empty = m.role === "assistant" && m.content === "";
        if (empty && proposals.length === 0 && instructions.length === 0) return null;
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
                      <CharacterMark character={character} size={12} />
                      {name}
                    </p>
                    <Markdown>{m.content}</Markdown>
                  </>
                )}
              </div>
            )}
            {(proposals.length > 0 || instructions.length > 0) && (
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
                {instructions.map(renderInstruction)}
              </div>
            )}
          </div>
        );
      })}
      {instructionProposals && instructionProposals.trailing.length > 0 && (
        <div className="w-full min-w-0 space-y-2">{instructionProposals.trailing.map(renderInstruction)}</div>
      )}
    </>
  );
}
