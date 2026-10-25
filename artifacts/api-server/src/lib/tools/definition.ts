import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { z } from "zod";
import type {
  CompositeDefinition,
  HttpDefinition,
  ToolKind,
  UiDefinition,
} from "./types";

const httpSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/", "il path deve iniziare con \"/\""),
  paramLocations: z.record(z.enum(["path", "query", "body"])),
  responseFields: z.array(z.string()).optional(),
});

const uiSchema = z.object({
  action: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

const compositeSchema = z.object({
  steps: z
    .array(z.object({ tool: z.string().min(1), args: z.record(z.string()) }))
    .min(1, "servono almeno un passo"),
  output: z.record(z.string()),
});

const schemasByKind = {
  http: httpSchema,
  ui: uiSchema,
  composite: compositeSchema,
} as const;

type ParsedDefinition = HttpDefinition | UiDefinition | CompositeDefinition;

export function parseDefinition(
  kind: ToolKind,
  definition: unknown,
): { ok: true; value: ParsedDefinition } | { ok: false; error: string } {
  const schema = schemasByKind[kind];
  if (!schema) return { ok: false, error: `tipo di tool sconosciuto: ${String(kind)}` };
  const parsed = schema.safeParse(definition);
  if (parsed.success) return { ok: true, value: parsed.data as ParsedDefinition };
  const issue = parsed.error.issues[0];
  const where = issue.path.length ? `"${issue.path.join(".")}": ` : "";
  return { ok: false, error: `definizione ${kind} non valida: ${where}${issue.message}` };
}

// strict: false per ammettere parole chiave sconosciute (es. x-sensitive)
const ajv = new Ajv({ allErrors: false, strict: false });
const cache = new WeakMap<object, ValidateFunction>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkParamsSchema(schema: unknown): string | null {
  if (!isPlainObject(schema)) return "lo schema dei parametri deve essere un oggetto JSON";
  if (schema.type !== "object") return "lo schema dei parametri deve avere type \"object\"";
  try {
    ajv.compile(schema);
  } catch (err) {
    return `schema dei parametri non valido: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

function describeError(err: ErrorObject): string {
  const path = err.instancePath
    .split("/")
    .filter(Boolean)
    .join(".");
  const params = err.params as Record<string, unknown>;
  switch (err.keyword) {
    case "required": {
      const missing = String(params.missingProperty);
      return `parametro "${path ? `${path}.${missing}` : missing}" obbligatorio mancante`;
    }
    case "type":
      return `parametro "${path}": deve essere ${String(params.type)}`;
    case "enum":
      return `parametro "${path}": deve essere uno tra ${JSON.stringify(params.allowedValues)}`;
    case "additionalProperties":
      return `parametro "${path ? `${path}.` : ""}${String(params.additionalProperty)}" non previsto`;
    default:
      return path ? `parametro "${path}": ${err.message ?? "non valido"}` : `argomenti non validi: ${err.message ?? ""}`.trim();
  }
}

export function validateArgs(schema: object, args: unknown): string | null {
  let validate = cache.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      return `schema dei parametri non valido: ${err instanceof Error ? err.message : String(err)}`;
    }
    cache.set(schema, validate);
  }
  if (validate(args)) return null;
  const first = validate.errors?.[0];
  return first ? describeError(first) : "argomenti non validi";
}

export function checkPathPlaceholders(def: HttpDefinition, schema: object): string | null {
  const placeholders = [...def.path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
  const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const name of placeholders) {
    if (!(name in props)) {
      return `il segnaposto {${name}} nel path non è un parametro dello schema`;
    }
    if (def.paramLocations[name] !== "path") {
      return `il parametro "${name}" compare nel path ma la sua posizione non è "path"`;
    }
  }
  for (const [name, loc] of Object.entries(def.paramLocations)) {
    if (loc === "path" && !placeholders.includes(name)) {
      return `il parametro "${name}" ha posizione "path" ma nel path manca il segnaposto {${name}}`;
    }
  }
  return null;
}
