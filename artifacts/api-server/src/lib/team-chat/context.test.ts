import { describe, expect, it } from "vitest";
import { WEB_INSTRUCTIONS } from "../web-reader/tool";
import { PERSONAL_INSTRUCTIONS_HEADER } from "../characters/personal-instructions";
import { INSTRUCTION_PROPOSAL_RULE } from "../characters/instruction-proposals";
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

describe("istruzioni personali nel prompt della chat di squadra", () => {
  it("in fondo al messaggio system se presenti, assenti senza il campo", () => {
    const block = `${PERSONAL_INSTRUCTIONS_HEADER}\nSempre il costo`;
    const withBlock = buildTeamChatMessages({ team: team(), memory: "", history: [], userMessage: "ciao", personalInstructions: block });
    expect(String(withBlock[0]!.content).endsWith(block)).toBe(true);
    const without = buildTeamChatMessages({ team: team(), memory: "", history: [], userMessage: "ciao" });
    expect(String(without[0]!.content)).not.toContain(PERSONAL_INSTRUCTIONS_HEADER);
  });
});

describe("proposte di istruzioni personali nella chat di squadra", () => {
  it("regola nel system e stato della scheda nella cronologia", () => {
    const msgs = buildTeamChatMessages({
      team: team(),
      memory: "",
      history: [
        { role: "user", content: "ciao", proposals: [] },
        { role: "assistant", content: "ecco", proposals: [], instructionProposals: ["accepted"] },
      ],
      userMessage: "grazie",
    });
    expect(TEAM_CHAT_SYSTEM_PROMPT).toContain(INSTRUCTION_PROPOSAL_RULE);
    expect(msgs.some((m) => m.role === "assistant" && String(m.content).includes("[scheda istruzioni personali: accepted]"))).toBe(true);
  });
});

describe("contesto della chat di squadra", () => {
  it("prompt di sistema senza dati; squadra in un messaggio user; delimitatori tolti; messaggio dell'utente in coda", () => {
    const msgs = buildTeamChatMessages({ team: team(), memory: "Appunti\n1 · breve", history: [], userMessage: "ciao" });
    expect(msgs[0]).toEqual({ role: "system", content: `${TEAM_CHAT_SYSTEM_PROMPT}\n${WEB_INSTRUCTIONS}` });
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
