# Casello

Hub per agentificare applicazioni: registra le tue app, configurale come agenti autonomi dotati di strumenti e istruzioni, e monitora le loro esecuzioni.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — avvia il server API (porta assegnata dal workflow)
- `pnpm --filter @workspace/casello run dev` — avvia il frontend React
- `pnpm run typecheck` — typecheck completo su tutti i package
- `pnpm run build` — typecheck + build di tutti i package
- `pnpm --filter @workspace/api-spec run codegen` — rigenera gli hook React Query e gli schema Zod dall'OpenAPI spec
- `pnpm --filter @workspace/db run push` — applica le modifiche allo schema DB (solo dev)
- Variabile richiesta: `DATABASE_URL` — stringa di connessione Postgres

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite (artifact `casello`)
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validazione: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (da spec OpenAPI)
- Build: esbuild (bundle CJS)

## Where things live

- `lib/api-spec/openapi.yaml` — contratto API, source of truth
- `lib/db/src/schema/` — schema Drizzle (una tabella per file)
- `artifacts/api-server/src/routes/` — route handlers Express
- `artifacts/casello/src/` — frontend React + Vite

## Domain Model

Casello ruota attorno a quattro entità principali:

- **App** — un'applicazione registrata che può essere agentificata (URL base, credenziali, stato)
- **Agent** — configurazione di un agente: quale App usa, prompt di sistema, modello LLM, stato
- **Tool** — uno strumento HTTP che l'agente può invocare (metodo, endpoint, schema parametri)
- **Run** — un'esecuzione di un agente: input, output, log, durata, esito

## Architecture decisions

- Contract-first: lo spec OpenAPI è la fonte di verità; tipi e hook vengono generati da esso
- Il backend valida input/output con gli schema Zod generati da Orval
- Le esecuzioni degli agenti (Run) vengono archiviate sul DB per audit e replay

## Product

Casello permette a team e sviluppatori di trasformare qualsiasi API REST in un agente autonomo configurabile, senza dover modificare il codice dell'app originale. Dal hub si gestisce il ciclo di vita completo: registrazione, configurazione, esecuzione e monitoraggio.

## User preferences

- Lingua: italiano per i commenti e la documentazione interna

## Gotchas

- Dopo ogni modifica a `lib/api-spec/openapi.yaml`, rieseguire codegen prima di usare i tipi aggiornati
- Non aggiungere `artifacts/casello` ai `references` del root `tsconfig.json` (è un leaf package)

## Pointers

- Vedi la skill `pnpm-workspace` per struttura workspace, TypeScript e convenzioni package
