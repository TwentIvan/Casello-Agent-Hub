import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ApiError,
  getGetNodePairingQueryKey,
  getListNodesQueryKey,
  useApproveNodePairing,
  useDenyNodePairing,
  useGetNodePairing,
  useListNodes,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { clearPairCode, readPairCode } from "@/lib/pair-code";

const MAX_NAME = 100;
const NEW_NODE = "new";
const NOT_FOUND = "Richiesta di collegamento non trovata o scaduta: riapri Botcave Nodo.";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

/** Pagina `/nodes/pair?code=…`: l'utente conferma il collegamento di un Mac aperto da Botcave Nodo. */
export default function NodePairPage() {
  // Il codice si legge una volta e si toglie dall'indirizzo: niente cronologia o copia-incolla con il codice dentro
  const [code] = useState(() => readPairCode(window.location.search));
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const pairing = useGetNodePairing(code ?? "", {
    query: { queryKey: getGetNodePairingQueryKey(code ?? ""), enabled: code !== null, retry: false },
  });
  const nodes = useListNodes({ query: { queryKey: getListNodesQueryKey() } });
  const activeNodes = useMemo(() => (nodes.data ?? []).filter((n) => n.status === "active"), [nodes.data]);

  const [name, setName] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  const deviceName = pairing.data?.deviceName ?? "";
  const effectiveName = name ?? deviceName;
  // Ricollega: preselezionato il nodo con lo stesso nome del Mac
  const sameName = activeNodes.find((n) => n.name.toLowerCase() === deviceName.toLowerCase());
  const effectiveChoice = choice ?? (sameName ? String(sameName.id) : NEW_NODE);

  const notFound =
    code === null || (pairing.isError && pairing.error instanceof ApiError && pairing.error.status === 404);
  useEffect(() => {
    if (notFound) clearPairCode();
  }, [notFound]);

  const approve = useApproveNodePairing({
    mutation: {
      onSuccess: () => {
        clearPairCode();
        setOutcome("approved");
      },
    },
  });
  const deny = useDenyNodePairing({
    mutation: {
      onSuccess: () => {
        clearPairCode();
        setOutcome("denied");
      },
    },
  });

  const nameValid = effectiveName.trim().length > 0 && effectiveName.trim().length <= MAX_NAME;
  const busy = approve.isPending || deny.isPending;
  const error = approve.error ?? deny.error;

  let body;
  if (outcome === "approved") {
    body = (
      <CardContent className="space-y-3">
        <Led state="ok" label="Mac collegato: torna a Botcave Nodo" />
        <Button asChild variant="outline" size="sm">
          <Link href="/account">Apri Account → Nodi</Link>
        </Button>
      </CardContent>
    );
  } else if (outcome === "denied") {
    body = (
      <CardContent>
        <Led state="idle" label="Collegamento annullato" />
      </CardContent>
    );
  } else if (notFound) {
    body = (
      <CardContent>
        <Led state="ko" label={NOT_FOUND} />
      </CardContent>
    );
  } else if (pairing.isError) {
    body = (
      <CardContent>
        <Led state="ko" label={apiErrorMessage(pairing.error)} />
      </CardContent>
    );
  } else if (!pairing.data) {
    body = (
      <CardContent>
        <Skeleton className="h-24 w-full" />
      </CardContent>
    );
  } else {
    const info = pairing.data;
    body = (
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!code || !nameValid || busy) return;
            const replaceNodeId = effectiveChoice === NEW_NODE ? null : Number(effectiveChoice);
            approve.mutate({ code, data: { name: effectiveName.trim(), replaceNodeId } });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="pair-name">Nome del Mac</Label>
            <Input
              id="pair-name"
              value={effectiveName}
              maxLength={MAX_NAME}
              disabled={effectiveChoice !== NEW_NODE}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            Botcave Nodo {info.version} · richiesta del {formatTime(info.createdAt)} · scade alle{" "}
            {new Date(info.expiresAt).toLocaleTimeString("it-IT", { timeStyle: "short" })}
          </p>
          <div className="space-y-2">
            <Label>Collega come</Label>
            <RadioGroup value={effectiveChoice} onValueChange={setChoice}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value={NEW_NODE} id="pair-new" />
                <Label htmlFor="pair-new" className="font-normal">
                  Nuovo nodo
                </Label>
              </div>
              {activeNodes.map((node) => (
                <div key={node.id} className="flex items-center gap-2">
                  <RadioGroupItem value={String(node.id)} id={`pair-${node.id}`} />
                  <Label htmlFor={`pair-${node.id}`} className="min-w-0 truncate font-normal">
                    Sostituisci {node.name}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <p className="rounded-md border p-3 text-sm">
            Conferma solo se hai appena aperto Botcave Nodo su questo Mac.
          </p>
          {error && <Led state="ko" label={apiErrorMessage(error)} />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!nameValid || busy}>
              {approve.isPending ? "Collegamento…" : "Collega"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => code && deny.mutate({ code })}>
              Annulla
            </Button>
          </div>
        </form>
      </CardContent>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-h2">Collega questo Mac</CardTitle>
          <CardDescription>Un Mac collegato esegue con Claude Code i compiti «nodo» delle tue squadre.</CardDescription>
        </CardHeader>
        {body}
      </Card>
    </div>
  );
}
