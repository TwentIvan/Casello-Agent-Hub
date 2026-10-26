import { describe, expect, it } from "vitest";
import { providerIssue } from "./provider-issue";

const provider = {
  slug: "nuovo_provider",
  name: "nuovo_provider",
  sourceKeys: { litellm: ["nuovo_provider"], openrouterAuthor: null },
  firstSeenAt: new Date("2026-10-20T08:00:00Z"),
};

describe("providerIssue", () => {
  it("titolo, nomi nelle fonti, numero di voci, esempi e cosa serve", () => {
    const { title, body } = providerIssue(provider, 7, ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"]);
    expect(title).toBe("Gestire il provider nuovo_provider in Casello");
    expect(body).toContain("## Contesto");
    expect(body).toContain("## Da fare");
    expect(body).toContain("7 voci");
    expect(body).toContain("20/10/2026");
    expect(body).toContain("litellm_provider: nuovo_provider");
    // Al massimo 5 esempi, nell'ordine dato
    expect(body).toContain("m-1\nm-2\nm-3\nm-4\nm-5\n");
    expect(body).not.toContain("m-6");
    for (const need of ["protocollo", "indirizzo", "source_keys", "provider-registry-data.ts"]) expect(body).toContain(need);
  });

  it("autore OpenRouter tra i nomi nelle fonti; nessun esempio → riga fissa", () => {
    const { body } = providerIssue({ ...provider, sourceKeys: { litellm: [], openrouterAuthor: "nuovo" } }, 0, []);
    expect(body).toContain("autore OpenRouter: nuovo");
    expect(body).toContain("0 voci");
    expect(body).toContain("Nessun id di esempio.");
  });

  it("nomi dalle fonti non aprono intestazioni né rompono i blocchi di codice", () => {
    const { title, body } = providerIssue({ ...provider, name: "## Evil\nname" }, 1, ["id```x"]);
    expect(title).toBe("Gestire il provider Evil name in Casello");
    expect(body).not.toMatch(/^## Evil/m);
    // Recinzione più lunga degli apici inversi contenuti
    expect(body).toContain("````\nid```x\n````");
  });
});
