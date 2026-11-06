import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_SKILL_PREFIX, INSTRUCTIONS_TEMPLATE, instructionsSkillCode, parseInstructionsFile } from "./instructions-file";

const file = (front: string, body = "# Sviluppatore\n\n## Identità\nScrive codice.") => `---\n${front}\n---\n${body}`;

describe("file di istruzioni del ruolo", () => {
  it("codice della skill", () => {
    expect(INSTRUCTIONS_SKILL_PREFIX).toBe("ruolo-");
    expect(instructionsSkillCode("dev")).toBe("ruolo-dev");
  });

  it("senza frontmatter iniziale è rifiutato", () => {
    expect(parseInstructionsFile("# Sviluppatore\n", "dev")).toEqual({ ok: false, error: "il file deve iniziare con il frontmatter del ruolo" });
    expect(parseInstructionsFile("\n---\nname: dev\ndescription: x\n---\n", "dev")).toMatchObject({ ok: false });
    // Frontmatter non chiuso
    expect(parseInstructionsFile("---\nname: dev\ndescription: x\n# Titolo", "dev")).toEqual({
      ok: false,
      error: "il file deve iniziare con il frontmatter del ruolo",
    });
    // Descrizione mancante o vuota
    expect(parseInstructionsFile(file("name: dev\ndescription:   "), "dev")).toEqual({
      ok: false,
      error: "il file deve iniziare con il frontmatter del ruolo",
    });
  });

  it("nome diverso dalla key del ruolo è rifiutato", () => {
    expect(parseInstructionsFile(file("name: tester\ndescription: prova"), "dev")).toEqual({ ok: false, error: "il nome nel frontmatter deve essere dev" });
  });

  it("file valido: nome e descrizione (anche tra virgolette e con CRLF)", () => {
    expect(parseInstructionsFile(file("name: dev\ndescription: Quando serve scrivere codice"), "dev")).toEqual({
      ok: true,
      name: "dev",
      description: "Quando serve scrivere codice",
    });
    expect(parseInstructionsFile('---\r\nname: "dev"\r\ndescription: \'Scrive\'\r\n---\r\n# Dev', "dev")).toEqual({ ok: true, name: "dev", description: "Scrive" });
  });

  it("lo scheletro ha le sezioni della spec ed è valido una volta riempito il frontmatter", () => {
    for (const s of ["## Identità", "## Responsabilità", "## Cosa ricevi", "## Cosa consegni", "## Come lavori", "## Strumenti", "## Limiti e quando fermarti", "## Criteri di qualità", "## Esempi"]) {
      expect(INSTRUCTIONS_TEMPLATE).toContain(s);
    }
    const filled = INSTRUCTIONS_TEMPLATE.replace("<key del ruolo>", "dev").replace("<una frase: quando il capo deve scegliere questo ruolo>", "Sviluppo");
    expect(parseInstructionsFile(filled, "dev")).toMatchObject({ ok: true, name: "dev" });
  });
});
