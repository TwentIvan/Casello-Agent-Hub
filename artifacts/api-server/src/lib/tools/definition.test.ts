import { describe, expect, it } from "vitest";
import {
  checkParamsSchema,
  checkPathPlaceholders,
  parseDefinition,
  validateArgs,
} from "./definition";
import type { HttpDefinition } from "./types";

describe("parseDefinition", () => {
  it("accetta una definizione http valida", () => {
    const r = parseDefinition("http", {
      method: "GET",
      path: "/api/teams/{teamId}",
      paramLocations: { teamId: "path" },
    });
    expect(r.ok).toBe(true);
  });

  it("rifiuta http senza path, con method sconosciuto o path senza slash", () => {
    expect(parseDefinition("http", { method: "GET", paramLocations: {} }).ok).toBe(false);
    expect(parseDefinition("http", { method: "FETCH", path: "/x", paramLocations: {} }).ok).toBe(false);
    expect(parseDefinition("http", { method: "GET", path: "x", paramLocations: {} }).ok).toBe(false);
  });

  it("rifiuta path pericolosi", () => {
    const bad = [
      "//evil.host/x", "/a/../b", "/../x", "/a/./b", "/a/%2e%2e/b", "/a/%2E/b", "/a?x=1", "/a#f",
      "/a\\b", "/a b", "/a\tb", "/a\nb", "/a%2fb", "/a%5Cb", "/a//b", "/a%00b", "http://altro/x", "/{1x}",
    ];
    for (const path of bad) {
      expect(parseDefinition("http", { method: "GET", path, paramLocations: {} }).ok, path).toBe(false);
    }
  });

  it("accetta path ben formati", () => {
    for (const path of ["/", "/api/teams/{teamId}/lineup", "/v1/items", "/a/b%20c/", "/x-y_z.json"]) {
      expect(parseDefinition("http", { method: "GET", path, paramLocations: {} }).ok, path).toBe(true);
    }
  });

  it("restituisce messaggi in italiano con il percorso del campo", () => {
    const m = parseDefinition("http", { method: "FETCH", path: "/x", paramLocations: {} });
    expect(m).toEqual({ ok: false, error: "definition.method: valore non ammesso (GET, POST, PUT, PATCH, DELETE)" });
    const p = parseDefinition("http", { method: "GET", paramLocations: {} });
    expect(p).toEqual({ ok: false, error: "definition.path: obbligatorio" });
    const c = parseDefinition("composite", { steps: [], output: {} });
    expect(c).toEqual({ ok: false, error: "definition.steps: servono almeno 1 elementi" });
    const u = parseDefinition("ui", { action: "" });
    expect(u).toEqual({ ok: false, error: "definition.action: non può essere vuoto" });
    const l = parseDefinition("http", { method: "GET", path: "/x", paramLocations: { a: "cookie" } });
    expect(l.ok === false && l.error).toBe("definition.paramLocations.a: valore non ammesso (path, query, body)");
  });

  it("accetta composite e ui valide", () => {
    expect(
      parseDefinition("composite", {
        steps: [{ tool: "a", args: { id: "$input.id" } }],
        output: { x: "$steps.0.id" },
      }).ok,
    ).toBe(true);
    expect(parseDefinition("ui", { action: "openTeam", args: { a: 1 } }).ok).toBe(true);
  });

  it("rifiuta composite senza passi e ui senza action", () => {
    expect(parseDefinition("composite", { steps: [], output: {} }).ok).toBe(false);
    expect(parseDefinition("ui", { action: "" }).ok).toBe(false);
  });
});

describe("checkParamsSchema", () => {
  it("accetta un object schema", () => {
    expect(checkParamsSchema({ type: "object", properties: { a: { type: "string", "x-sensitive": true } } })).toBeNull();
  });
  it("rifiuta array, type non valido e non-oggetti", () => {
    expect(checkParamsSchema({ type: "array" })).not.toBeNull();
    expect(checkParamsSchema({ type: 5 })).not.toBeNull();
    expect(checkParamsSchema("x")).not.toBeNull();
  });
  it("rifiuta $ref", () => {
    const err = checkParamsSchema({
      type: "object",
      properties: { a: { $ref: "#/definitions/x" } },
    });
    expect(err).toContain("$ref");
  });
  it("ammette una proprietà chiamata $ref", () => {
    expect(checkParamsSchema({ type: "object", properties: { $ref: { type: "string" } } })).toBeNull();
  });
});

describe("validateArgs", () => {
  const schema = {
    type: "object",
    properties: { teamId: { type: "integer" } },
    required: ["teamId"],
  };
  it("accetta argomenti validi", () => {
    expect(validateArgs(schema, { teamId: 3 })).toBeNull();
  });
  it("rifiuta argomenti mancanti o di tipo errato", () => {
    expect(validateArgs(schema, {})).toContain("teamId");
    expect(validateArgs(schema, { teamId: "x" })).toContain("teamId");
  });
  it("funziona con oggetti schema distinti ma uguali, ripetutamente", () => {
    const make = () => ({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
    for (let i = 0; i < 5; i++) {
      expect(validateArgs(make(), { n: i })).toBeNull();
      expect(validateArgs(make(), {})).toContain("\"n\"");
    }
  });
  it("funziona con uno schema con $id validato più volte", () => {
    const make = () => ({ $id: "https://x/s", type: "object", properties: { n: { type: "integer" } } });
    expect(validateArgs(make(), { n: 1 })).toBeNull();
    expect(validateArgs(make(), { n: 2 })).toBeNull();
    expect(validateArgs(make(), { n: "x" })).toContain("n");
  });
  it("usa un messaggio sensato per un tipo errato alla radice", () => {
    expect(validateArgs(schema, "x")).toBe("argomenti: devono essere un oggetto");
  });
});

describe("checkPathPlaceholders", () => {
  const schema = { type: "object", properties: { teamId: { type: "integer" } }, required: ["teamId"] };
  it("segnala un segnaposto assente dallo schema", () => {
    const def: HttpDefinition = { method: "GET", path: "/t/{teamId}", paramLocations: {} };
    expect(checkPathPlaceholders(def, { type: "object", properties: {} })).toContain("teamId");
  });
  it("segnala un parametro path senza segnaposto", () => {
    const def: HttpDefinition = { method: "GET", path: "/t", paramLocations: { teamId: "path" } };
    expect(checkPathPlaceholders(def, schema)).toContain("teamId");
  });
  it("segnala un segnaposto non required", () => {
    const def: HttpDefinition = { method: "GET", path: "/t/{teamId}", paramLocations: { teamId: "path" } };
    expect(checkPathPlaceholders(def, { type: "object", properties: { teamId: {} } })).toContain("required");
  });
  it("non confonde proprietà ereditate con parametri", () => {
    const def: HttpDefinition = { method: "GET", path: "/t/{toString}", paramLocations: Object.fromEntries([["toString", "path"]]) as HttpDefinition["paramLocations"] };
    expect(checkPathPlaceholders(def, { type: "object", properties: {}, required: ["toString"] })).toContain("toString");
  });
  it("accetta la corrispondenza", () => {
    const def: HttpDefinition = { method: "GET", path: "/t/{teamId}", paramLocations: { teamId: "path" } };
    expect(checkPathPlaceholders(def, schema)).toBeNull();
  });
});
