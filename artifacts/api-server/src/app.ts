import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import "./lib/characters/subjects";
import { ATTACHMENT_UPLOAD_PATH } from "./lib/teams/attachments";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/auth";
import { oauthErrorHandler, oauthRouter } from "./routes/oauth";
import { mcpRouter } from "./lib/mcp/server";
import { mcpTurnRouter } from "./lib/mcp/turn-server";
import { hooksRouter } from "./routes/hooks";
import { redactHookPath } from "./lib/triggers/secrets";
import { redactPairingPath } from "./lib/nodes/pairing";
import { errorHandler } from "./middlewares/error-handler";

const app: Express = express();

const isProduction = process.env.NODE_ENV === "production";

// In produzione davanti all'API ci sono due proxy (Traefik di Coolify, poi nginx di casello-web):
// req.ip deve essere il client reale, non nginx, per il rate limit delle run, e X-Forwarded-Proto
// dice se la richiesta originale era HTTPS, necessario per il cookie di sessione "secure".
// Un numero di hop e non `true`: con `true` l'IP arriverebbe da X-Forwarded-For, falsificabile.
if (isProduction) app.set("trust proxy", 2);

// CORS: in produzione solo l'origine pubblica della UI (PUBLIC_APP_URL), in dev qualsiasi localhost.
// La UI chiama /api sullo stesso dominio, quindi CORS serve solo a non aprire l'API ad altri siti.
const publicAppOrigin = process.env["PUBLIC_APP_URL"]
  ? new URL(process.env["PUBLIC_APP_URL"]).origin
  : undefined;
if (isProduction && !publicAppOrigin) {
  logger.warn("PUBLIC_APP_URL non impostata: CORS rifiuta ogni origine esterna");
}
const localhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = isProduction
      ? origin === publicAppOrigin
      : localhostOrigin.test(origin) || origin === publicAppOrigin;
    callback(null, allowed);
  },
};

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Il percorso di un webhook contiene il segreto (`/api/hooks/<id>/***`), quello dell'abbinamento il codice (`…/node-pairings/***`).
          url: req.url === undefined ? undefined : redactPairingPath(redactHookPath(req.url.split("?")[0]!)),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Server MCP per gli agenti locali: fuori da /api, prima di CORS, del parser JSON globale (ha il
// suo, fino a 2 MB per gli esiti di fase) e della sessione. Autenticazione solo con il token
// personale (Bearer), niente cookie; nessuna origine CORS ammessa: non è chiamato dai browser.
// /mcp/turn (token del turno `cat_…`) va prima di /mcp, che altrimenti lo catturerebbe
app.use("/mcp/turn", mcpTurnRouter());
app.use("/mcp", mcpRouter());
// Webhook in entrata degli inneschi: pubblici (il segreto è nel percorso), prima di CORS, dei parser globali e
// della sessione; parser grezzo proprio da 256 KB. Non sono chiamati dai browser.
app.use("/api/hooks", hooksRouter());
app.use(cors(corsOptions));
// Il caricamento di un allegato ha il suo parser grezzo (10 MB) sulla route: i parser globali lo saltano.
// Il protocollo dei nodi ha un parser JSON da 256 KB al posto di quello globale (100 KB): un report con `detail` di
// 20 000 caratteri tutti da escapare supera i 100 KB e verrebbe perso.
const jsonParser = express.json();
const nodeJsonParser = express.json({ limit: "256kb" });
const NODE_PROTOCOL_PATH = /^\/api\/node(?:\/|$)/i;
const formParser = express.urlencoded({ extended: true });
const isAttachmentUpload = (req: express.Request): boolean => req.method === "POST" && ATTACHMENT_UPLOAD_PATH.test(req.originalUrl.split("?")[0]!);
// I webhook hanno il loro parser: il corpo non passa mai dai parser globali, nemmeno su un percorso non gestito.
const HOOKS_PATH = /^\/api\/hooks(?:\/|$)/i;
const skipGlobalParsers = (req: express.Request): boolean => isAttachmentUpload(req) || HOOKS_PATH.test(req.originalUrl.split("?")[0]!);
app.use((req, res, next) => {
  if (skipGlobalParsers(req)) return next();
  const parser = NODE_PROTOCOL_PATH.test(req.originalUrl.split("?")[0]!) ? nodeJsonParser : jsonParser;
  return parser(req, res, next);
});
app.use((req, res, next) => (skipGlobalParsers(req) ? next() : formParser(req, res, next)));
app.use(sessionMiddleware());
// Connettore OAuth (well-known e /oauth/*), alla radice: fuori da /api.
app.use(oauthRouter());
app.use("/oauth", oauthErrorHandler);

app.use("/api", router);
// Dopo il router: errori di validazione → 400, il resto → 500, sempre in JSON
app.use("/api", errorHandler);

export default app;
