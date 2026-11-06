import { describe, expect, it } from "vitest";
import { consumeTeamChatMessage, consumeTeamMessage } from "./rate-limit";

describe("limite dei messaggi della chat di squadra", () => {
  it("10 al minuto per utente, contatore proprio", () => {
    for (let i = 0; i < 10; i++) expect(consumeTeamChatMessage(7001)).toBe(true);
    expect(consumeTeamChatMessage(7001)).toBe(false);
    // Altro utente e contatore dei messaggi al capo non toccati
    expect(consumeTeamChatMessage(7002)).toBe(true);
    expect(consumeTeamMessage(7001)).toBe(true);
  });
});
