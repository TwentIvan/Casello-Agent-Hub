import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  type Agent,
  type AiAccount,
  type AiModel,
  type Budget,
  cancelRun,
  getGetAgentQueryKey,
  getGetBudgetQueryKey,
  getGetDashboardStatsQueryKey,
  getListAgentsQueryKey,
  getListRunsQueryKey,
  useGetBudget,
  useUpdateAgent,
  useUpdateAiAccount,
  useUpdateAiModel,
  useUpdateBudget,
} from "@workspace/api-client-react";
import { invalidateAiQueries } from "@/components/ai/ai-queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RunStatusBadge } from "@/components/run-status-badge";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatUsd } from "@/lib/format";

// Tetti di spesa mensili: riepilogo dall'API (GET /budget), avviso all'80% e finestra per annullare le run
// che continuano a spendere su un tetto già raggiunto.

const REFRESH_MS = 60_000;
const WARN_RATIO = 0.8;

export function useBudget() {
  return useGetBudget({ query: { queryKey: getGetBudgetQueryKey(), refetchInterval: REFRESH_MS } });
}

function ratio(spent: number, cap: number | null): number | null {
  if (cap === null) return null;
  return cap === 0 ? 1 : spent / cap;
}

function unpricedNote(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? " Un'esecuzione è senza prezzo: la spesa reale è più alta."
    : ` ${count} esecuzioni sono senza prezzo: la spesa reale è più alta.`;
}

/** Riga "spesi X su Y" con barra; senza tetto solo la spesa. */
function SpendLine({ spent, cap, unpriced }: { spent: number; cap: number | null; unpriced: number }) {
  const r = ratio(spent, cap);
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Questo mese: <span className="font-medium tabular-nums">{formatUsd(spent)}</span>
        {cap !== null && (
          <>
            {" "}
            su <span className="font-medium tabular-nums">{formatUsd(cap)}</span>
            {r !== null && <span className="text-muted-foreground"> ({Math.round(r * 100)}%)</span>}
          </>
        )}
        <span className="text-muted-foreground">{unpricedNote(unpriced)}</span>
      </p>
      {r !== null && <Progress value={Math.min(100, r * 100)} className={r >= 1 ? "[&>div]:bg-destructive" : undefined} />}
    </div>
  );
}

/** Campo del tetto: vuoto = nessun limite. `compact` per le celle di tabella. */
function CapForm({
  value,
  pending,
  onSave,
  compact = false,
  label = "Tetto mensile in USD",
}: {
  value: number | null;
  pending: boolean;
  onSave: (v: number | null) => void;
  compact?: boolean;
  label?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const trimmed = text.trim().replace(",", ".");
  // Al centesimo, come lo salva l'API: altrimenti 5,001 su un tetto di 5 resterebbe "da salvare" per sempre
  const parsed = trimmed === "" ? null : Math.round(Number(trimmed) * 100) / 100;
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000);
  const changed = parsed !== value;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && changed) onSave(parsed);
      }}
    >
      <Input
        inputMode="decimal"
        className={compact ? "h-8 w-24 tabular-nums" : "w-40"}
        placeholder={compact ? "—" : "Nessun limite"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label={label}
        aria-invalid={!valid}
      />
      {!compact && <span className="text-sm text-muted-foreground">USD al mese</span>}
      {(!compact || changed) && (
        <Button type="submit" size="sm" className={compact ? "h-8" : undefined} disabled={!valid || !changed || pending}>
          {pending ? "Salvataggio…" : "Salva"}
        </Button>
      )}
      {!valid && <span className="text-sm text-destructive">Un importo tra 0 e 1 000 000.</span>}
    </form>
  );
}

/** Pagina Account: tetto mensile sui propri account AI. */
export function UserBudgetCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const budget = useBudget();
  const update = useUpdateBudget({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetBudgetQueryKey(), data);
        toast({ title: data.user.capUsd === null ? "Tetto di spesa tolto" : "Tetto di spesa salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Tetto non salvato", description: apiErrorMessage(error) }),
    },
  });
  const user = budget.data?.user;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tetto di spesa</CardTitle>
        <CardDescription>
          Spesa del mese sui tuoi account AI (run, analisi nel cloud, chat del piano). Raggiunto il tetto, Casello non
          avvia nulla di nuovo fino al mese prossimo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {budget.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare la spesa: {apiErrorMessage(budget.error)}</p>
        ) : !user ? (
          <p className="text-sm text-muted-foreground">Caricamento…</p>
        ) : (
          <>
            <SpendLine spent={user.spentUsd} cap={user.capUsd} unpriced={user.unpricedCount} />
            <CapForm
              key={String(user.capUsd)}
              value={user.capUsd}
              pending={update.isPending}
              onSave={(monthlyBudgetUsd) => update.mutate({ data: { monthlyBudgetUsd } })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Scheda agente: tetto mensile delle sue run, con qualsiasi modello. */
export function AgentBudgetCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const budget = useBudget();
  const update = useUpdateAgent({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetAgentQueryKey(agent.id), data);
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetBudgetQueryKey() });
        toast({ title: data.monthlyBudgetUsd === null ? "Tetto di spesa tolto" : "Tetto di spesa salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Tetto non salvato", description: apiErrorMessage(error) }),
    },
  });
  const spend = budget.data?.agents.find((a) => a.agentId === agent.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tetto di spesa</CardTitle>
        <CardDescription>
          Spesa del mese delle run di questo agente. Raggiunto il tetto, nuove run non partono fino al mese prossimo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {spend && <SpendLine spent={spend.spentUsd} cap={spend.capUsd} unpriced={spend.unpricedCount} />}
        <CapForm
          key={String(agent.monthlyBudgetUsd)}
          value={agent.monthlyBudgetUsd}
          pending={update.isPending}
          onSave={(monthlyBudgetUsd) => update.mutate({ id: agent.id, data: { monthlyBudgetUsd } })}
        />
      </CardContent>
    </Card>
  );
}

/** Pagina Account, sotto un account AI: tetto mensile su tutti i suoi modelli (il credito si carica per chiave). */
export function AiAccountBudget({ account }: { account: AiAccount }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const budget = useBudget();
  const update = useUpdateAiAccount({
    mutation: {
      onSuccess: (data) => {
        void invalidateAiQueries(queryClient);
        void queryClient.invalidateQueries({ queryKey: getGetBudgetQueryKey() });
        toast({ title: data.monthlyBudgetUsd === null ? "Tetto dell'account tolto" : "Tetto dell'account salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Tetto non salvato", description: apiErrorMessage(error) }),
    },
  });
  const spend = budget.data?.accounts.find((a) => a.accountId === account.id);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Tetto di spesa dell'account</p>
      <p className="text-xs text-muted-foreground">
        Spesa del mese su tutti i modelli di questa chiave. Raggiunto il tetto, nulla di nuovo parte su questo account
        fino al mese prossimo.
      </p>
      {spend && <SpendLine spent={spend.spentUsd} cap={spend.capUsd} unpriced={spend.unpricedCount} />}
      <CapForm
        key={String(account.monthlyBudgetUsd)}
        value={account.monthlyBudgetUsd}
        pending={update.isPending}
        label={`Tetto mensile in USD dell'account ${account.name}`}
        onSave={(monthlyBudgetUsd) => update.mutate({ id: account.id, data: { monthlyBudgetUsd } })}
      />
    </div>
  );
}

/** Cella della tabella dei modelli: tetto mensile del modello e spesa del mese se ha un tetto. */
export function AiModelBudgetCell({ model }: { model: AiModel }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const budget = useBudget();
  const update = useUpdateAiModel({
    mutation: {
      onSuccess: () => {
        void invalidateAiQueries(queryClient);
        void queryClient.invalidateQueries({ queryKey: getGetBudgetQueryKey() });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Tetto non salvato", description: apiErrorMessage(error) }),
    },
  });
  const spend = budget.data?.models.find((m) => m.aiModelId === model.id);
  const r = spend ? ratio(spend.spentUsd, spend.capUsd) : null;

  return (
    <div className="space-y-1">
      <CapForm
        compact
        key={String(model.monthlyBudgetUsd)}
        value={model.monthlyBudgetUsd}
        pending={update.isPending}
        label={`Tetto mensile in USD di ${model.modelId}`}
        onSave={(monthlyBudgetUsd) => update.mutate({ id: model.id, data: { monthlyBudgetUsd } })}
      />
      {spend && r !== null && (
        <p className={`text-xs tabular-nums ${r >= 1 ? "text-destructive" : "text-muted-foreground"}`}>
          spesi {formatUsd(spend.spentUsd)} ({Math.round(r * 100)}%)
        </p>
      )}
    </div>
  );
}

interface Warning {
  key: string;
  title: string;
  text: string;
  href: string;
  exhausted: boolean;
}

function warnings(budget: Budget): Warning[] {
  const result: Warning[] = [];
  const { user } = budget;
  const r = ratio(user.spentUsd, user.capUsd);
  if (r !== null && r >= WARN_RATIO) {
    result.push({
      key: "user",
      title: r >= 1 ? "Tetto di spesa raggiunto" : "Tetto di spesa quasi raggiunto",
      text: `Questo mese hai speso ${formatUsd(user.spentUsd)} su ${formatUsd(user.capUsd!)} (${Math.round(r * 100)}%).${unpricedNote(user.unpricedCount)}`,
      href: "/account",
      exhausted: r >= 1,
    });
  }
  for (const a of budget.agents) {
    const ar = ratio(a.spentUsd, a.capUsd)!;
    if (ar < WARN_RATIO) continue;
    result.push({
      key: `agent-${a.agentId}`,
      title: `${a.agentName}: ${ar >= 1 ? "tetto raggiunto" : "tetto quasi raggiunto"}`,
      text: `Questo mese l'agente ha speso ${formatUsd(a.spentUsd)} su ${formatUsd(a.capUsd)} (${Math.round(ar * 100)}%).${unpricedNote(a.unpricedCount)}`,
      href: `/agents/${a.agentId}`,
      exhausted: ar >= 1,
    });
  }
  for (const a of budget.accounts) {
    const ar = ratio(a.spentUsd, a.capUsd)!;
    if (ar < WARN_RATIO) continue;
    result.push({
      key: `account-${a.accountId}`,
      title: `Account AI ${a.accountName}: ${ar >= 1 ? "tetto raggiunto" : "tetto quasi raggiunto"}`,
      text: `Questo mese l'account ha speso ${formatUsd(a.spentUsd)} su ${formatUsd(a.capUsd)} (${Math.round(ar * 100)}%).${unpricedNote(a.unpricedCount)}`,
      href: "/account",
      exhausted: ar >= 1,
    });
  }
  for (const m of budget.models) {
    const mr = ratio(m.spentUsd, m.capUsd)!;
    if (mr < WARN_RATIO) continue;
    result.push({
      key: `model-${m.aiModelId}`,
      title: `Modello ${m.modelName} (${m.accountName}): ${mr >= 1 ? "tetto raggiunto" : "tetto quasi raggiunto"}`,
      text: `Questo mese il modello ha speso ${formatUsd(m.spentUsd)} su ${formatUsd(m.capUsd)} (${Math.round(mr * 100)}%).${unpricedNote(m.unpricedCount)}`,
      href: "/account",
      exhausted: mr >= 1,
    });
  }
  return result;
}

/** Dashboard: avvisi dall'80% del tetto (dell'utente, degli agenti, degli account AI e dei modelli). */
export function BudgetAlerts() {
  const budget = useBudget();
  if (!budget.data) return null;
  return (
    <>
      {warnings(budget.data).map((w) => (
        <Alert key={w.key} variant={w.exhausted ? "destructive" : "default"}>
          <AlertTriangle className="size-4" />
          <AlertTitle>{w.title}</AlertTitle>
          <AlertDescription>
            {w.text}{" "}
            <Link href={w.href} className="font-medium underline underline-offset-4">
              {w.exhausted ? "Alza il tetto" : "Rivedi il tetto"}
            </Link>
            {w.exhausted && " o attendi il mese prossimo: nel frattempo non parte nulla di nuovo su questo tetto."}
          </AlertDescription>
        </Alert>
      ))}
    </>
  );
}

const DISMISSED_KEY = "casello.budget.dismissedRuns";

function readDismissed(): Set<number> {
  try {
    return new Set((sessionStorage.getItem(DISMISSED_KEY) ?? "").split(",").filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<number>) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, [...ids].join(","));
  } catch {
    // senza storage la finestra può ricomparire: nessun danno
  }
}

/**
 * Finestra globale: con un tetto raggiunto e run ancora in corso o in attesa su quel tetto, propone di
 * annullarle. "Lasciale finire" la chiude finché non compaiono run nuove (per la sessione del browser).
 */
export function BudgetGuard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const budget = useBudget();
  const [dismissed, setDismissed] = useState<Set<number>>(readDismissed);
  const [cancelling, setCancelling] = useState(false);

  const runs = budget.data?.activeRuns ?? [];
  // Si riapre solo per una run mai vista: una run che finisce non la fa ricomparire
  const open = runs.some((r) => !dismissed.has(r.id));

  const dismiss = () => {
    // Solo le run ancora attive: l'elenco salvato non cresce senza limite
    const ids = new Set(runs.map((r) => r.id));
    writeDismissed(ids);
    setDismissed(ids);
  };

  const cancelAll = async () => {
    setCancelling(true);
    // Una run conclusa nel frattempo risponde 409: si conta tra le non annullate
    const results = await Promise.allSettled(runs.map((r) => cancelRun(r.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    setCancelling(false);
    for (const queryKey of [getGetBudgetQueryKey(), getListRunsQueryKey(), getGetDashboardStatsQueryKey()]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    toast(
      failed === 0
        ? { title: runs.length === 1 ? "Run annullata" : `${runs.length} run annullate` }
        : { variant: "destructive", title: `${failed} run non annullate`, description: "Forse erano già concluse." },
    );
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Tetto di spesa raggiunto</AlertDialogTitle>
          <AlertDialogDescription>
            Nessuna nuova esecuzione partirà su quel tetto fino al mese prossimo, ma{" "}
            {runs.length === 1
              ? "questa run è ancora in corso e può continuare a spendere. Vuoi annullarla?"
              : `queste ${runs.length} run sono ancora in corso e possono continuare a spendere. Vuoi annullarle?`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-60 space-y-2 overflow-y-auto">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
              <Link href={`/runs/${r.id}`} className="min-w-0 truncate hover:underline" onClick={dismiss}>
                #{r.id} · {r.agentName}
              </Link>
              <RunStatusBadge status={r.status} />
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancelling}>Lasciale finire</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={cancelling}
            onClick={(event) => {
              event.preventDefault();
              void cancelAll();
            }}
          >
            {cancelling ? "Annullamento…" : runs.length === 1 ? "Annullala" : "Annulla tutte"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
