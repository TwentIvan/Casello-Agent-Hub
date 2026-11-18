import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type App, getGetAppQueryKey, useUpdateApp } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

/** Nomi con cui Alfred, Lucius e il Responsabile si presentano nel plugin di questa App. */
export function BotNamesCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [alfred, setAlfred] = useState(app.alfredName ?? "");
  const [lucius, setLucius] = useState(app.luciusName ?? "");
  const [lead, setLead] = useState(app.leadName ?? "");

  useEffect(() => {
    setAlfred(app.alfredName ?? "");
    setLucius(app.luciusName ?? "");
    setLead(app.leadName ?? "");
  }, [app.alfredName, app.luciusName, app.leadName]);

  const update = useUpdateApp({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAppQueryKey(app.id) });
        toast({ title: "Nomi dei bot salvati" });
      },
      onError: (error) => toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const leadPlaceholder = app.slug === "casello" ? "Barbara" : "Responsabile";
  const fields = [
    { id: "bot-alfred", label: "Maggiordomo", value: alfred, set: setAlfred, placeholder: "Alfred" },
    { id: "bot-lucius", label: "Ingegnere", value: lucius, set: setLucius, placeholder: "Lucius" },
    { id: "bot-lead", label: "Responsabile", value: lead, set: setLead, placeholder: leadPlaceholder },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-h2">Bot del plugin</CardTitle>
        <CardDescription>
          I nomi con cui i bot si presentano nel pannello di questa App. Un campo vuoto torna al nome predefinito.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {fields.map((f) => (
            <div key={f.id} className="space-y-1.5">
              <Label htmlFor={f.id} className="text-label">{f.label}</Label>
              <Input id={f.id} value={f.value} maxLength={40} placeholder={f.placeholder} onChange={(e) => f.set(e.target.value)} />
            </div>
          ))}
        </div>
        <Button
          disabled={update.isPending}
          onClick={() => update.mutate({ id: app.id, data: { alfredName: orNull(alfred), luciusName: orNull(lucius), leadName: orNull(lead) } })}
        >
          Salva
        </Button>
      </CardContent>
    </Card>
  );
}
