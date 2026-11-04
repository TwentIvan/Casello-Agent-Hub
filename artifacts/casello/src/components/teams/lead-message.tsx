import { useQueryClient } from "@tanstack/react-query";
import { type TeamInstance, getListTeamTurnsQueryKey, useSendTeamMessage } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const MAX_TEXT = 4000;

/** «Scrivi al capo»: il messaggio diventa un motivo del prossimo turno del capo (solo squadre attive). */
export function LeadMessageCard({
  team,
  text,
  onTextChange: setText,
  onSent,
}: {
  team: TeamInstance;
  /** Testo tenuto dalla pagina: non si perde quando l'editor della squadra si rimonta. */
  text: string;
  onTextChange: (text: string) => void;
  onSent: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const active = team.status === "active";
  const send = useSendTeamMessage({
    mutation: {
      onSuccess: () => {
        setText("");
        void queryClient.invalidateQueries({ queryKey: getListTeamTurnsQueryKey(team.id) });
        onSent();
        toast({ title: "Messaggio inviato al capo", description: "Lo legge nel prossimo turno." });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Messaggio non inviato", description: apiErrorMessage(error) }),
    },
  });
  const trimmed = text.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scrivi al capo</CardTitle>
        <CardDescription>
          Richieste, correzioni o risposte ai punti aperti: il capo le legge nel prossimo turno.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (active && trimmed) send.mutate({ id: team.id, data: { text: trimmed } });
          }}
        >
          <Textarea
            rows={3}
            maxLength={MAX_TEXT}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!active || send.isPending}
            aria-label="Messaggio al capo"
            placeholder={active ? "Scrivi al capo della squadra…" : undefined}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {active
                ? `${text.length.toLocaleString("it-IT")} / ${MAX_TEXT.toLocaleString("it-IT")} caratteri`
                : team.status === "draft"
                  ? "Attiva la squadra per scrivere al capo."
                  : "La squadra è chiusa: il capo non riceve più messaggi."}
            </span>
            <Button type="submit" disabled={!active || !trimmed || send.isPending}>
              {send.isPending ? "Invio…" : "Invia"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
