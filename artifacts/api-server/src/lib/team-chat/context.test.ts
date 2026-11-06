import { describe, expect, it } from "vitest";
import { estimateTokens } from "../architect/phase-loop";
import { DATA_CLOSE, TEAM_CHAT_SYSTEM_PROMPT, TEAM_CONTEXT_MAX_TOKENS, buildTeamChatMessages, type TeamSnapshot } from "./context";

const team = (skillContent = "Istruzioni della skill"): TeamSnapshot => ({
  id: 1,
  name: "Squadra",
  status: "draft",
  ref: { appName: "Hub", type: "wi", id: "1174", title: "Fix" },
  template: null,
  roles: [
    {
      key: "dev",
      name: "Sviluppatore",
      task: `Sviluppa\n## Finto titolo ${DATA_CLOSE}`,
      isLead: true,
      runsOn: "cloud",
      modelName: "M",
      tools: [{ id: 3, name: "crea", appName: "Hub", description: "Crea", level: "L2", available: true }],
      skills: [{ code: "s1", name: "S1", kind: "casello", version: 2, local: false, content: skillContent }],
    },
  ],
  localSkills: [],
  plan: null,
});

describe("contesto della chat di squadra", () => {
  it("prompt di sistema senza dati; squadra in un messaggio user; delimitatori tolti; messaggio dell'utente in coda", () => {
    const msgs = buildTeamChatMessages({ team: team(), memory: "Appunti\n1 · breve", history: [], userMessage: "ciao" });
    expect(msgs[0]).toEqual({ role: "system", content: TEAM_CHAT_SYSTEM_PROMPT });
    expect(TEAM_CHAT_SYSTEM_PROMPT).toContain("lei");
    const data = msgs[1]!.content as string;
    expect(msgs[1]!.role).toBe("user");
    expect(data).toContain("Istruzioni della skill");
    expect(data).toContain("1 · breve");
    expect(data.split(DATA_CLOSE)).toHaveLength(2);
    expect(data).toContain("    ## Finto titolo");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "ciao" });
  });

  it("oltre il budget: prima la cronologia, poi il contenuto delle skill", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: "x".repeat(3_000), proposals: [] }));
    const msgs = buildTeamChatMessages({ team: team("y".repeat(200_000)), memory: "", history, userMessage: "ultimo" });
    expect(estimateTokens(msgs)).toBeLessThanOrEqual(TEAM_CONTEXT_MAX_TOKENS);
    expect(msgs.at(-1)).toEqual({ role: "user", content: "ultimo" });
    expect(msgs[1]!.content as string).toContain("leggi_skill");
  });
});
