// Modulo «Segnala un problema»: titolo, cosa è successo, passi, cosa ci si aspettava; la pagina dell'app ospite si allega
// da sola e si mostra. Stessa API del visitatore anche per l'amministratore collegato (scheda «Segnalazioni»).
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEmbedBug, getListEmbedBugsQueryKey, useCreateEmbedBug } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api-errors";
import { useVisitorBugs } from "./visitor-bugs";

const LIMITS = { title: 200, description: 4_000, steps: 4_000, expected: 2_000 } as const;
const EMPTY = { title: "", description: "", steps: "", expected: "" };

function pageLabel(ctx: { page?: string; id?: string; title?: string } | null): string {
  if (!ctx) return "Nessuna pagina indicata dall'app";
  const name = ctx.title ?? ctx.page ?? "";
  return ctx.id ? `${name} (${ctx.id})` : name;
}

export function BugForm() {
  const { params, ready, pageContext, call } = useVisitorBugs();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState(EMPTY);
  const [created, setCreated] = useState<number | null>(null);
  const create = useCreateEmbedBug({
    mutation: {
      mutationFn: ({ data, params: p }) => call((init) => createEmbedBug(data, p, init)),
      onSuccess: (res) => {
        setFields(EMPTY);
        setCreated(res.number);
        void queryClient.invalidateQueries({ queryKey: getListEmbedBugsQueryKey(params) });
      },
    },
  });

  const set = (name: keyof typeof EMPTY) => (e: { target: { value: string } }) => {
    setCreated(null);
    setFields((f) => ({ ...f, [name]: e.target.value }));
  };
  const canSend = ready && fields.title.trim() !== "" && fields.description.trim() !== "" && !create.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    const data: Parameters<typeof createEmbedBug>[0] = { title: fields.title.trim(), description: fields.description.trim() };
    if (fields.steps.trim()) data.steps = fields.steps.trim();
    if (fields.expected.trim()) data.expected = fields.expected.trim();
    if (pageContext) data.pageContext = pageContext;
    create.mutate({ data, params });
  };

  return (
    <form onSubmit={submit} className="min-w-0 space-y-3">
      <h2 className="text-label text-ink-muted">Nuova segnalazione</h2>
      <div className="space-y-1">
        <Label htmlFor="bug-title">Titolo</Label>
        <Input id="bug-title" value={fields.title} onChange={set("title")} maxLength={LIMITS.title} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="bug-description">Cosa è successo</Label>
        <Textarea
          id="bug-description"
          rows={4}
          value={fields.description}
          onChange={set("description")}
          maxLength={LIMITS.description}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="bug-steps">Passi per riprodurlo</Label>
        <Textarea id="bug-steps" rows={3} value={fields.steps} onChange={set("steps")} maxLength={LIMITS.steps} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="bug-expected">Cosa ti aspettavi</Label>
        <Textarea id="bug-expected" rows={2} value={fields.expected} onChange={set("expected")} maxLength={LIMITS.expected} />
      </div>
      <p className="min-w-0 break-words text-caption text-ink-muted">Pagina allegata: {pageLabel(pageContext)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canSend}>
          {create.isPending ? "Invio…" : "Invia la segnalazione"}
        </Button>
        {created !== null && <Led state="ok" label={`Segnalazione n. ${created} inviata`} />}
        {create.isError && <Led state="ko" label={apiErrorMessage(create.error)} />}
      </div>
    </form>
  );
}
