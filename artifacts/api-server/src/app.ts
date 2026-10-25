import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

const isProduction = process.env.NODE_ENV === "production";

// In produzione davanti all'API ci sono due proxy (Traefik di Coolify, poi nginx di casello-web):
// req.ip deve essere il client reale, non nginx, per il rate limit delle run.
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
