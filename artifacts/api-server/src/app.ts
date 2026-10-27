import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/auth";
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
          url: req.url?.split("?")[0],
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
app.use(cors(corsOptions));
// /api/mcp legge il proprio corpo dopo l'autenticazione, con un limite più alto (routes/mcp.ts)
const jsonBody = express.json();
app.use((req, res, next) => (req.path === "/api/mcp" || req.path.startsWith("/api/mcp/") ? next() : jsonBody(req, res, next)));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware());

app.use("/api", router);
// Dopo il router: errori di validazione → 400, il resto → 500, sempre in JSON
app.use("/api", errorHandler);

export default app;
