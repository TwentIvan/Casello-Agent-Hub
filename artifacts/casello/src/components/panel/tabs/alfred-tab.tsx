// Scheda «Alfred» del pannello: il filo scritto di Alfred con il contesto della pagina (console o app ospite) e il
// microfono per parlargli a voce (use-alfred-voice.ts, una sessione attiva per utente). La voce la tiene
// AlfredVoiceProvider: la scheda la mostra soltanto, così cambiare scheda o chiudere il pannello non la ferma.
import { Mic, Square } from "lucide-react";
import { AlfredTranscript } from "@/components/alfred/alfred-transcript";
import type { AlfredStatus, AlfredVoice } from "@/components/alfred/use-alfred-voice";
import { Led, type LedState } from "@/components/brand/led";
import { CharacterChat } from "@/components/characters/character-chat";
import { Button } from "@/components/ui/button";
import { usePanel } from "../panel-context";
import { PanelLink } from "../panel-link";
import { useSharedAlfredVoice } from "../voice-context";

const STATUS: Record<AlfredStatus, [string, LedState]> = {
  stopped: ["Voce ferma", "idle"],
  connecting: ["Mi collego…", "idle"],
  listening: ["In ascolto", "work"],
  speaking: ["Alfred parla", "work"],
};

function AlfredVoiceBar({ voice, fullScreenLink }: { voice: AlfredVoice; fullScreenLink: boolean }) {
  const { status, error, lines, start, stop } = voice;
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
        {fullScreenLink && (
          <PanelLink path="/alfred" className="shrink-0 text-body-sm text-accent-text underline underline-offset-2">
            A tutto schermo
          </PanelLink>
        )}
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
              <PanelLink path="/account" className="text-accent-text underline underline-offset-2">
                Apri Account in Botcave
              </PanelLink>
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

export function AlfredTab() {
  const { state, env, alfredPage, hasUnsavedChanges } = usePanel();
  const voice = useSharedAlfredVoice();
  const draft = state.draft?.tab === "alfred" ? state.draft.text : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Nell'iframe /alfred si aprirebbe in un'altra scheda, senza la voce in corso: solo nella console */}
      <AlfredVoiceBar voice={voice} fullScreenLink={env.surface === "console"} />
      <div className="min-h-0 flex-1">
        <CharacterChat
          key={state.nonce}
          target={{ kind: "alfred", page: alfredPage }}
          draft={draft}
          hasUnsavedChanges={hasUnsavedChanges}
          layout="sheet"
        />
      </div>
    </div>
  );
}
