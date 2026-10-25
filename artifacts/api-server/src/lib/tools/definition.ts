import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { z, type ZodIssue } from "zod";
import type {
  CompositeDefinition,
  HttpDefinition,
  ToolKind,
  UiDefinition,
} from "./types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const LOCATIONS = ["path", "query", "body"] as const;

// Un segmento è fatto di caratteri non riservati, byte percent-encoded e segnaposto {nome}
const SEGMENT_TOKEN = /^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2}|\{[A-Za-z_][A-Za-z0-9_]*\})+$/;

/** Verifica il path di un tool http: resta relativo all'host dell'app e senza traversal. */
export function checkHttpPath(path: string): string | null {
  if (!path.startsWith("/")) return "deve iniziare con \"/\"";
  if (path === "/") return null;
  const segments = path.slice(1).split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "") {
      if (i === segments.length - 1) continue; // slash finale ammesso
      return "contiene un segmento vuoto (\"//\")";
    }
    if (!SEGMENT_TOKEN.test(seg)) {
      return "contiene caratteri non ammessi (spazi, \"?\", \"#\", \"\\\", caratteri di controllo)";
    }
    const bytes = [...seg.matchAll(/%([0-9A-Fa-f]{2})/g)].map((m) => parseInt(m[1], 16));
    if (bytes.some((b) => b === 0x2f || b === 0x5c || b < 0x20 || b === 0x7f)) {
      return "contiene byte codificati non ammessi (%2f, %5c, controllo)";
    }
    const decoded = seg.replace(/%2e/gi, ".");
    if (decoded === "." || decoded === "..") return "non può contenere segmenti \".\" o \"..\"";
  }
  return null;
}

const httpSchema = z.object({
  method: z.enum(METHODS),
  path: z.string().superRefine((value, ctx) => {
    const err = checkHttpPath(value);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  }),
  paramLocations: z.record(z.enum(LOCATIONS)),
  responseFields: z.array(z.string()).optional(),
});

const uiSchema = z.object({
  action: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

const compositeSchema = z.object({
  steps: z
    .array(z.object({ tool: z.string().min(1), args: z.record(z.string()) }))
    .min(1),
  output: z.record(z.string()),
});

const schemasByKind = {
  http: httpSchema,
  ui: uiSchema,
  composite: compositeSchema,
} as const;

type ParsedDefinition = HttpDefinition | UiDefinition | CompositeDefinition;

const TYPE_IT: Record<string, string> = {
  string: "una stringa",
  number: "un numero",
  object: "un oggetto",
  array: "un elenco",
  boolean: "un booleano",
};

function italianIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return "obbligatorio";
      return `deve essere ${TYPE_IT[issue.expected] ?? issue.expected}`;
    case "invalid_enum_value":
      return `valore non ammesso (${issue.options.join(", ")})`;
    case "too_small":
      if (issue.type === "string") return "non può essere vuoto";
      if (issue.type === "array") return `servono almeno ${String(issue.minimum)} elementi`;
      return "valore troppo piccolo";
    case "custom":
      return issue.message;
    default:
      return "valore non valido";
  }
}

export function parseDefinition(
  kind: ToolKind,
  definition: unknown,
): { ok: true; value: ParsedDefinition } | { ok: false; error: string } {
  const schema = schemasByKind[kind];
  if (!schema) return { ok: false, error: `tipo di tool sconosciuto: ${String(kind)}` };
  const parsed = schema.safeParse(definition);
  if (parsed.success) return { ok: true, value: parsed.data as ParsedDefinition };
  const issue = parsed.error.issues[0];
  const field = ["definition", ...issue.path].join(".");
  return { ok: false, error: `${field}: ${italianIssue(issue)}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Un'istanza di Ajv per compilazione: così Ajv non trattiene gli schemi compilati
// e due schemi con lo stesso `$id` non entrano in conflitto. strict: false per
// ammettere parole chiave sconosciute (es. x-sensitive).
function compileSchema(schema: object): ValidateFunction {
  return new Ajv({ allErrors: false, strict: false }).compile(schema);
}

/** Cerca `$ref` (non supportati) in tutto lo schema; ignora i nomi di proprietà. */
function hasRef(node: unknown, isPropertiesMap = false): boolean {
  if (Array.isArray(node)) return node.some((n) => hasRef(n));
  if (!isPlainObject(node)) return false;
  return Object.entries(node).some(([key, value]) => {
    if (!isPropertiesMap && (key === "$ref" || key === "$dynamicRef")) return true;
    return hasRef(value, !isPropertiesMap && (key === "properties" || key === "patternProperties"));
  });
}

export function checkParamsSchema(schema: unknown): string | null {
  if (!isPlainObject(schema)) return "lo schema dei parametri deve essere un oggetto JSON";
  if (schema.type !== "object") return "lo schema dei parametri deve avere type \"object\"";
  if (hasRef(schema)) return "lo schema dei parametri non può usare $ref (riferimenti non supportati)";
  try {
    compileSchema(schema);
  } catch (err) {
    return `schema dei parametri non valido: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

// Cache limitata dei validatori, per contenuto dello schema (gli schemi arrivano dal DB
// come oggetti nuovi a ogni richiesta). Si scarta la voce più vecchia oltre il limite.
const MAX_CACHED_VALIDATORS = 500;
const cache = new Map<string, ValidateFunction>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function describeError(err: ErrorObject): string {
  const path = err.instancePath.split("/").filter(Boolean).join(".");
  const params = err.params as Record<string, unknown>;
  switch (err.keyword) {
    case "required": {
      const missing = String(params.missingProperty);
      return `parametro "${path ? `${path}.${missing}` : missing}" obbligatorio mancante`;
    }
    case "type":
      return path
        ? `parametro "${path}": deve essere ${String(params.type)}`
        : "argomenti: devono essere un oggetto";
    case "enum":
      return `parametro "${path}": deve essere uno tra ${JSON.stringify(params.allowedValues)}`;
    case "additionalProperties":
      return `parametro "${path ? `${path}.` : ""}${String(params.additionalProperty)}" non previsto`;
    default:
      return path
        ? `parametro "${path}": ${err.message ?? "non valido"}`
        : `argomenti non validi: ${err.message ?? ""}`.trim();
  }
}

export function validateArgs(schema: object, args: unknown): string | null {
  const key = stableStringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    try {
      validate = compileSchema(schema);
    } catch (err) {
      return `schema dei parametri non valido: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (cache.size >= MAX_CACHED_VALIDATORS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, validate);
  }
  if (validate(args)) return null;
  const first = validate.errors?.[0];
  return first ? describeError(first) : "argomenti non validi";
}

export function checkPathPlaceholders(def: HttpDefinition, schema: object): string | null {
  const placeholders = [...def.path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
  const { properties, required } = schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const props = properties ?? {};
  const req = Array.isArray(required) ? required : [];
  for (const name of placeholders) {
    if (!Object.hasOwn(props, name)) {
      return `il segnaposto {${name}} nel path non è un parametro dello schema`;
    }
    if (!req.includes(name)) {
      return `il parametro "${name}" compare nel path ma non è tra i parametri obbligatori (required)`;
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
