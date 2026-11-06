// Scheda «Alfred» del pannello: il filo scritto di Alfred (lo stesso della console) con il contesto della pagina ospite,
// e il microfono per parlargli a voce dentro il pannello (use-alfred-voice.ts, una sessione attiva per utente).
import { useMemo } from "react";
import { Mic, Square } from "lucide-react";
import { AlfredTranscript } from "@/components/alfred/alfred-transcript";
import { type AlfredStatus, useAlfredVoice } from "@/components/alfred/use-alfred-voice";
import { Led, type LedState } from "@/components/brand/led";
import { CharacterChat } from "@/components/characters/character-chat";
import { Button } from "@/components/ui/button";
import type { HostContextMsg } from "../protocol";
import { alfredPageContext, consoleUrl } from "../panel-helpers";

const STATUS: Record<AlfredStatus, [string, LedState]> = {
  stopped: ["Voce ferma", "idle"],
  connecting: ["Mi collego…", "idle"],
  listening: ["In ascolto", "work"],
  speaking: ["Alfred parla", "work"],
};

function AlfredVoiceBar() {
  const { status, error, lines, start, stop } = useAlfredVoice();
  const running = status !== "stopped";
  return (
    <div className="min-w-0 space-y-2 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={running ? "secondary" : "default"}
          onClick={() => void (running ? stop() : start())}
          aria-label={running ? "Ferma la voce di Alfred" : "Parla con Alfred"}
        >
          {running ? <Square /> : <Mic />}
          {running ? "Basta così" : "Parla con Alfred"}
        </Button>
        <span aria-live="polite" className="min-w-0 truncate">
          <Led state={STATUS[status][1]} label={STATUS[status][0]} />
        </span>
      </div>
      {error && (
        <p className="break-words text-body-sm">
          <Led state={error.kind === "closed" ? "idle" : "ko"} label={error.message} />
          {error.kind === "model" && (
            <>
              {" "}
              <a
                href={consoleUrl(window.location.origin, "/account")}
                target="_blank"
                rel="noopener"
                className="text-accent-text underline underline-offset-2"
              >
                Apri Account in Botcave
              </a>
            </>
          )}
        </p>
      )}
      {lines.length > 0 && (
        <div className="max-h-40 overflow-y-auto">
          <AlfredTranscript lines={lines} />
        </div>
      )}
    </div>
  );
}

export function AlfredTab({ appSlug, hostContext }: { appSlug: string; hostContext: HostContextMsg | null }) {
  const page = useMemo(() => alfredPageContext(appSlug, hostContext), [appSlug, hostContext]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AlfredVoiceBar />
      <div className="min-h-0 flex-1">
        <CharacterChat target={{ kind: "alfred", page }} layout="sheet" />
      </div>
    </div>
  );
}
