import { type FormEvent, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AiAccount,
  type AiAccountUpdate,
  type AiProvider,
  useCreateAiAccount,
  useUpdateAiAccount,
} from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { invalidateAiQueries } from "@/components/ai/ai-queries";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Provider che l'utente può scegliere; rispecchia PROVIDERS dell'API (system_gateway escluso). */
type UserProvider = Exclude<AiProvider, "system_gateway">;

export const PROVIDER_INFO: Record<UserProvider, { label: string; defaultBaseUrl: string | null }> = {
  deepseek: { label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com/v1" },
  openrouter: { label: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  huggingface: { label: "Hugging Face", defaultBaseUrl: "https://router.huggingface.co/v1" },
  mistral: { label: "Mistral", defaultBaseUrl: "https://api.mistral.ai/v1" },
  groq: { label: "Groq", defaultBaseUrl: "https://api.groq.com/openai/v1" },
  together: { label: "Together", defaultBaseUrl: "https://api.together.xyz/v1" },
  gemini: { label: "Google Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  custom: { label: "Personalizzato", defaultBaseUrl: null },
};

export function providerLabel(provider: AiProvider): string {
  return provider === "system_gateway" ? "Gateway di Casello" : PROVIDER_INFO[provider].label;
}

interface AiAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Account da modificare; assente per l'aggiunta. */
  account?: AiAccount;
}

/** Aggiunta o modifica di un account AI: l'API verifica la chiave leggendo i modelli prima di salvare. */
export function AiAccountDialog({ open, onOpenChange, account }: AiAccountDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const editing = account !== undefined;

  const [provider, setProvider] = useState<UserProvider>("deepseek");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);


  // Le variabili di una mutation (quindi la chiave in chiaro) restano nella MutationCache di React Query:
  // reset() a fine chiamata stacca l'osservatore e gcTime 0 fa uscire subito la mutation dalla cache.
  const createAccount = useCreateAiAccount({
    mutation: {
      gcTime: 0,
      onSuccess: (created) => {
        setApiKey("");
        createAccount.reset();
        void invalidateAiQueries(queryClient);
        onOpenChange(false);
        toast({ title: `Account aggiunto: ${created.modelCount} modelli trovati` });
      },
      onError: (err) => {
        setError(apiErrorMessage(err));
        createAccount.reset();
      },
    },
  });
  const updateAccount = useUpdateAiAccount({
    mutation: {
      gcTime: 0,
      onSuccess: () => {
        setApiKey("");
        updateAccount.reset();
        void invalidateAiQueries(queryClient);
        onOpenChange(false);
        toast({ title: "Account aggiornato" });
      },
      onError: (err) => {
        setError(`${apiErrorMessage(err)}: la configurazione precedente resta attiva.`);
        updateAccount.reset();
      },
    },
  });
  // A ogni apertura si riparte dai dati dell'account (o da un modulo vuoto); la chiave non è mai precompilata.
  useEffect(() => {
    if (!open) {
      // La chiave non resta in memoria a dialog chiuso: né nello stato né nelle variabili delle mutation
      setApiKey("");
      createAccount.reset();
      updateAccount.reset();
      return;
    }
    setProvider(account && account.provider !== "system_gateway" ? account.provider : "deepseek");
    setName(account?.name ?? "");
    setBaseUrl(account?.provider === "custom" ? account.baseUrl : "");
    setApiKey("");
    setAllowPrivateNetwork(account?.allowPrivateNetwork ?? false);
    setError(null);
    // Solo all'apertura o al cambio di account: un refetch dell'elenco non deve cancellare quanto scritto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  const pending = createAccount.isPending || updateAccount.isPending;

  const isCustom = provider === "custom";
  const trimmedName = name.trim();
  const trimmedUrl = baseUrl.trim();
  const key = apiKey.trim();
  const valid =
    trimmedName.length > 0 &&
    trimmedName.length <= 100 &&
    (!isCustom || trimmedUrl.length > 0) &&
    // Senza chiave solo i server personalizzati; in modifica la chiave vuota resta quella di prima
    (editing || isCustom || key.length > 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setError(null);
    if (!account) {
      createAccount.mutate({
        data: {
          name: trimmedName,
          provider,
          ...(key ? { apiKey: key } : {}),
          ...(isCustom ? { baseUrl: trimmedUrl, allowPrivateNetwork } : {}),
        },
      });
      return;
    }
    const data: AiAccountUpdate = {};
    if (trimmedName !== account.name) data.name = trimmedName;
    if (key) data.apiKey = key;
    if (isCustom && trimmedUrl !== account.baseUrl) data.baseUrl = trimmedUrl;
    if (isCustom && allowPrivateNetwork !== account.allowPrivateNetwork) data.allowPrivateNetwork = allowPrivateNetwork;
    if (Object.keys(data).length === 0) {
      onOpenChange(false);
      return;
    }
    updateAccount.mutate({ id: account.id, data });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Modifica account AI" : "Aggiungi account AI"}</DialogTitle>
          <DialogDescription>
            Casello legge l'elenco dei modelli con la chiave prima di salvare. La chiave è conservata cifrata e non
            viene mai mostrata.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ai-account-provider">Provider</Label>
            {editing ? (
              <p id="ai-account-provider" className="text-sm">
                {PROVIDER_INFO[provider].label}
              </p>
            ) : (
              <Select value={provider} onValueChange={(v) => setProvider(v as UserProvider)}>
                <SelectTrigger id="ai-account-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVIDER_INFO) as UserProvider[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {PROVIDER_INFO[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-account-name">Nome</Label>
            <Input
              id="ai-account-name"
              value={name}
              maxLength={100}
              placeholder="es. DeepSeek personale"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-account-base-url">Base URL</Label>
            {isCustom ? (
              <Input
                id="ai-account-base-url"
                value={baseUrl}
                maxLength={2048}
                placeholder="https://esempio.it/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            ) : (
              <p id="ai-account-base-url" className="font-mono text-sm break-all text-muted-foreground">
                {PROVIDER_INFO[provider].defaultBaseUrl}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-account-key">Chiave API</Label>
            <Input
              id="ai-account-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              maxLength={4096}
              placeholder={editing ? "invariata (lascia vuoto)" : isCustom ? "facoltativa" : undefined}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          {isCustom && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="ai-account-private"
                  checked={allowPrivateNetwork}
                  onCheckedChange={(checked) => setAllowPrivateNetwork(checked === true)}
                />
                <Label htmlFor="ai-account-private">Consenti rete privata</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Attenzione: permette http e indirizzi della rete interna (es. un modello su un server della LAN);
                localhost e gli indirizzi dei metadati restano vietati. Attivalo solo per server che controlli tu.
              </p>
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? "Verifica…" : "Salva e verifica"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
