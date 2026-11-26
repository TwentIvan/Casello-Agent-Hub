// Ricetta di avvio del collaudo: validazione pura (nessun DB, nessuna rete)
import { looksLikeCredential } from "../memory/credentials";
import { COLLAUDO_MESSAGES } from "./messages";

export type TestRecipe = {
  install: string[];
  build: string[];
  services: { name: string; command: string; port: number; readyPath: string }[];
  postgres: boolean;
  schema: string[];
  env: Record<string, string>;
  startUrl: string;
  login: string | null;
};

export type RecipeResult = { ok: true; recipe: TestRecipe } | { ok: false; error: string };

const MAX_COMMAND = 500;
const MAX_STEPS = 20;
const MAX_ENV_KEYS = 40;
const MAX_ENV_VALUE = 500;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_NAME = 40;
const MAX_LOGIN = 200;

type Obj = Record<string, unknown>;

function fail(detail: string): RecipeResult {
  return { ok: false, error: COLLAUDO_MESSAGES.invalidRecipe(detail) };
}

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un comando: una riga, 1..500 caratteri, nessuna credenziale. */
function checkCommand(value: unknown, where: string): string | null {
  if (typeof value !== "string") return `${where}: il comando deve essere testo`;
  if (value.includes("\n") || value.includes("\r")) return `${where}: il comando deve stare su una riga`;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_COMMAND) {
    return `${where}: il comando deve avere 1..${MAX_COMMAND} caratteri`;
  }
  if (looksLikeCredential(trimmed)) return `${where}: il comando sembra contenere una credenziale`;
  return null;
}

function checkCommandList(value: unknown, where: string): string | null {
  if (!Array.isArray(value)) return `${where}: deve essere una lista`;
  for (const [i, item] of value.entries()) {
    const err = checkCommand(item, `${where}[${i}]`);
    if (err) return err;
  }
  return null;
}

function checkPort(value: unknown, where: string): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return `${where}: porta non valida`;
  }
  return null;
}

function checkPath(value: unknown, where: string): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 300) {
    return `${where}: deve essere un percorso che comincia con /`;
  }
  return null;
}

function checkName(value: unknown, where: string): string | null {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > MAX_NAME) {
    return `${where}: nome non valido`;
  }
  return null;
}

/** Valida la ricetta proposta dal capo o dal repository di collaudo. */
export function validateRecipe(input: unknown): RecipeResult {
  if (!isObject(input)) return fail("deve essere un oggetto");

  const install = input.install;
  const build = input.build;
  const schema = input.schema;
  const err1 = checkCommandList(install, "install");
  if (err1) return fail(err1);
  const err2 = checkCommandList(build, "build");
  if (err2) return fail(err2);
  const err3 = checkCommandList(schema, "schema");
  if (err3) return fail(err3);

  if (!Array.isArray(input.services)) return fail("services: deve essere una lista");
  const services: TestRecipe["services"] = [];
  for (const [i, raw] of input.services.entries()) {
    const where = `services[${i}]`;
    if (!isObject(raw)) return fail(`${where}: deve essere un oggetto`);
    const nameErr = checkName(raw.name, `${where}.name`);
    if (nameErr) return fail(nameErr);
    const cmdErr = checkCommand(raw.command, `${where}.command`);
    if (cmdErr) return fail(cmdErr);
    const portErr = checkPort(raw.port, `${where}.port`);
    if (portErr) return fail(portErr);
    const pathErr = checkPath(raw.readyPath, `${where}.readyPath`);
    if (pathErr) return fail(pathErr);
    services.push({
      name: String(raw.name),
      command: String(raw.command),
      port: raw.port as number,
      readyPath: String(raw.readyPath),
    });
  }

  const steps =
    (install as string[]).length + (build as string[]).length + services.length + (schema as string[]).length;
  if (steps > MAX_STEPS) return fail(`troppi passi: al massimo ${MAX_STEPS}`);

  if (typeof input.postgres !== "boolean") return fail("postgres: deve essere vero o falso");

  if (!isObject(input.env)) return fail("env: deve essere un oggetto");
  const envEntries = Object.entries(input.env);
  if (envEntries.length > MAX_ENV_KEYS) return fail(`env: al massimo ${MAX_ENV_KEYS} variabili`);
  const env: Record<string, string> = {};
  for (const [key, value] of envEntries) {
    if (!ENV_KEY.test(key)) return fail(`env: nome di variabile non valido`);
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE) {
      return fail(`env: il valore di ${key} deve essere testo fino a ${MAX_ENV_VALUE} caratteri`);
    }
    if (looksLikeCredential(value)) return fail(`env: ${key} sembra contenere una credenziale`);
    env[key] = value;
  }

  const startErr = checkPath(input.startUrl, "startUrl");
  if (startErr) return fail(startErr);

  let login: string | null = null;
  if (input.login !== null && input.login !== undefined) {
    if (typeof input.login !== "string" || input.login.length > MAX_LOGIN) {
      return fail("login: testo non valido");
    }
    if (looksLikeCredential(input.login)) return fail("login: sembra contenere una credenziale");
    login = input.login;
  }

  return {
    ok: true,
    recipe: {
      install: [...(install as string[])],
      build: [...(build as string[])],
      services,
      postgres: input.postgres,
      schema: [...(schema as string[])],
      env,
      startUrl: String(input.startUrl),
      login,
    },
  };
}
