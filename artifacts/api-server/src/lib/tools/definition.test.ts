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
});

describe("checkPathPlaceholders", () => {
  const schema = { type: "object", properties: { teamId: { type: "integer" } } };
  it("segnala un segnaposto assente dallo schema", () => {
    const def: HttpDefinition = { method: "GET", path: "/t/{teamId}", paramLocations: {} };
    expect(checkPathPlaceholders(def, { type: "object", properties: {} })).toContain("teamId");
  });
  it("segnala un parametro path senza segnaposto", () => {
    const def: HttpDefinition = { method: "GET", path: "/t", paramLocations: { teamId: "path" } };
    expect(checkPathPlaceholders(def, schema)).toContain("teamId");
  });
  it("accetta la corrispondenza", () => {
    const def: HttpDefinition = { method: "GET", path: "/t/{teamId}", paramLocations: { teamId: "path" } };
    expect(checkPathPlaceholders(def, schema)).toBeNull();
  });
});
