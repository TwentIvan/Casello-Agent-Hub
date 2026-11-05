import { useEffect } from "react";
import { Link } from "wouter";
import { Mic, Square } from "lucide-react";
import { AlfredTranscript } from "@/components/alfred/alfred-transcript";
import { type AlfredStatus, useAlfredVoice } from "@/components/alfred/use-alfred-voice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const STATUS_LABELS: Record<AlfredStatus, string> = {
  stopped: "fermo",
  connecting: "collego…",
  listening: "ascolto",
  speaking: "parla",
};

/** Collega manifest e icona di Alfred solo finché la pagina è montata. */
function useAlfredInstallable() {
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    const tags: HTMLElement[] = [];
    const add = (tag: string, attrs: Record<string, string>) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      document.head.appendChild(el);
      tags.push(el);
    };
    add("link", { rel: "manifest", href: `${base}alfred.webmanifest` });
    add("link", { rel: "apple-touch-icon", href: `${base}alfred-icon-180.png` });
    add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
    add("meta", { name: "apple-mobile-web-app-title", content: "Alfred" });
    return () => tags.forEach((el) => el.remove());
  }, []);
}

export default function AlfredPage() {
  useAlfredInstallable();
  const { status, error, lines, start, stop } = useAlfredVoice();
  const running = status !== "stopped";

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Alfred</h2>
        <p className="text-sm text-muted-foreground">Il maggiordomo vocale: chiedi delle tue squadre e decidi a voce.</p>
      </div>
      <Button
        size="lg"
        className="h-20 w-full text-xl"
        variant={running ? "destructive" : "default"}
        disabled={status === "connecting"}
        onClick={() => void (running ? stop() : start())}
      >
        {running ? <Square /> : <Mic />}
        {running ? "Basta così" : "Parla"}
      </Button>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Stato: <span className="font-medium text-foreground">{STATUS_LABELS[status]}</span>
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Alfred non è disponibile</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{error.message}</p>
            {error.kind === "model" && (
              <Link href="/account" className="font-medium underline">
                Vai ad Account
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent className="pt-6">
          <AlfredTranscript lines={lines} />
        </CardContent>
      </Card>
    </div>
  );
}
