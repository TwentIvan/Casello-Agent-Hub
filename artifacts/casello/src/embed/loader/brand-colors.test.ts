import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LED_ON, ON_LED } from "./brand-colors";

type Token = { name: string; value: unknown };

describe("colori del caricatore", () => {
  it("sono quelli di design/tokens.json", () => {
    const json = JSON.parse(readFileSync(new URL("../../../../../design/tokens.json", import.meta.url), "utf8")) as {
      color: { tokens: Token[] };
    };
    const value = (name: string) => json.color.tokens.find((t) => t.name === name)?.value;
    expect(LED_ON).toBe(value("ambra"));
    expect(ON_LED).toBe(value("notte"));
  });
});
