import { describe, expect, it } from "vitest";
import { characterInstructions } from "./instructions";

describe("characterInstructions", () => {
  it("senza opzioni, o con il nome canonico, il testo è invariato", () => {
    expect(characterInstructions("alfred")).not.toContain("ti chiami");
    expect(characterInstructions("alfred", { displayName: "Alfred" })).toBe(characterInstructions("alfred"));
    expect(characterInstructions("lucius", { displayName: "Lucius" })).toBe(characterInstructions("lucius"));
  });

  it("con un nome diverso aggiunge la riga dopo la prima", () => {
    const lines = characterInstructions("alfred", { displayName: "Jeeves" }).split("\n");
    expect(lines[0]).toContain("Sei Alfred");
    expect(lines[1]).toBe("In questa app ti chiami Jeeves.");
    expect(lines.slice(2)).toEqual(characterInstructions("alfred").split("\n").slice(1));
  });

  it("vale anche per Lucius", () => {
    expect(characterInstructions("lucius", { displayName: "Edison" }).split("\n")[1]).toBe("In questa app ti chiami Edison.");
  });
});
