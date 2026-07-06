# Fase 1 — LiteLLM davanti a Casello

> Vive dentro questo repo per comodità, ma è un servizio Python
> completamente autonomo: nessun file qui sotto importa o dipende da
> nient'altro nel monorepo pnpm. Quando servirà un deploy/versioning
> indipendente da Casello, questa cartella si estrae così com'è in un
> repo dedicato (`git subtree split -P gateway` oppure una semplice
> copia + `git init`) senza modifiche.

Obiettivo: mettere LiteLLM come proxy di tutte le chiamate AI di Casello,
attivare il prompt caching sui context pack degli agenti, e misurare per una
settimana. Rollback in ogni momento rimuovendo un solo secret.

## 1. Repl gateway (Python)

1. Crea un nuovo Repl Python (es. `ai-gateway-litellm`).
2. Carica `gateway/config.yaml` di questo repo nella root del Repl.
3. Installa: `pip install 'litellm[proxy]'`
4. Secrets del Repl:
   - `LITELLM_MASTER_KEY` — genera un valore lungo e casuale (prefisso consigliato `sk-`); è la chiave admin, non va mai nelle app
   - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — le stesse oggi in Casello
   - `DATABASE_URL` — Postgres del Repl (crea il DB integrato di Replit e copia l'URL)
5. Comando di run:
   `litellm --config config.yaml --host 0.0.0.0 --port $PORT`
   (in locale nel workspace usa `--port 4000`)
6. Deploy come **Reserved VM** (sempre acceso). Non usare autoscale: il gateway
   non deve avere cold start né perdere stato. Verifica le opzioni correnti di
   deployment nella doc Replit, cambiano spesso.

## 2. Virtual key (una per app, poi una per organizzazione)

Per la settimana di misura basta una chiave per Casello:

```bash
curl -X POST https://<repl-gateway>.replit.app/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "casello",
    "metadata": {"app": "casello"},
    "max_budget": 100.0,
    "budget_duration": "30d"
  }'
```

Conserva la `key` restituita: è il valore di `AI_GATEWAY_API_KEY`.
La granularità per-agente (una virtual key per agente/app registrata) è
un'estensione futura: per ora la telemetria per-agente viaggia nei tag
(vedi patch A / `caller`+`agentId` in `ai-gateway.ts`).

## 3. Smoke test

```bash
curl https://<repl-gateway>.replit.app/chat/completions \
  -H "Authorization: Bearer <virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "ping"}]}'
```

Ripeti con `"model": "anthropic/claude-opus-4-8"` per verificare il ramo Anthropic.

## 4. Ripuntamento Casello

Nei secrets del deploy di Casello aggiungi:

- `AI_GATEWAY_BASE_URL` = `https://<repl-gateway>.replit.app`
- `AI_GATEWAY_API_KEY` = la virtual key del punto 2

Non serve toccare il codice per il ripuntamento: la modalità proxy esiste già
in `artifacts/api-server/src/lib/ai-gateway.ts` e ha priorità su tutto.
`OPENAI_API_KEY` e `ANTHROPIC_API_KEY` restano nell'app come paracadute.

**Rollback totale = cancellare `AI_GATEWAY_BASE_URL`.** L'app torna alle
chiamate dirette al deploy successivo.

## 5. Cosa misurare nella settimana

- **Spesa reale**: la fonte di verità è lo spend log di LiteLLM
  (`GET /spend/logs`, o le tabelle nel Postgres del gateway), che prezza
  correttamente i token cachati. Casello non ha una tabella di pricing
  interna: usa LiteLLM come unica fonte per il totale.
- **Hit rate cache**: nei log del gateway (`ai-gateway.ts`) comparirà
  `cached=N`. Sui run ripetuti dello stesso agente deve salire dopo la prima
  chiamata. Nota il vincolo Anthropic: i blocchi sotto ~1024 token non
  vengono cachati, quindi agenti con contesto scarno (poche tool, system
  prompt breve) non beneficiano — è atteso, non è un bug.
- **Latenza**: `duration=` nei log era già presente; confronta la settimana
  prima/dopo per il costo del hop aggiuntivo.
- Criterio di uscita: se il risparmio sui run ripetitivi per agente è
  tangibile, il valore sta nel layer di contesto. Altrimenti hai comunque
  guadagnato fallback, multi-provider e virtual key.

## Note

- I `model_name` nel config devono restare sincronizzati con il campo
  `model` che gli agenti usano (tabella `agents` in Casello): quando crei
  un agente con un nuovo model key, aggiungi la voce corrispondente nel
  config.yaml del gateway.
- Il ramo `anthropic/`/`openai/` diretto in `ai-gateway.ts` diventa codice
  morto finché il proxy è attivo: NON rimuoverlo, è il paracadute del
  rollback.
