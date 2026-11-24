import { describe, expect, it } from "vitest";
import { checkCron, formatLocal, nextCronTime, parseCron } from "./cron";

const next = (expr: string, after: string) => nextCronTime(parseCron(expr)!, new Date(after))?.toISOString() ?? null;

describe("parseCron", () => {
  it("accetta le forme comuni", () => {
    for (const expr of ["0 8 * * *", "*/15 * * * *", "0 9 * * 1-5", "30 2 1,15 * *", "0 0 * 1-6/2 7", "5/10 * * * *"]) {
      expect(parseCron(expr), expr).not.toBeNull();
    }
  });

  it("rifiuta le forme non valide", () => {
    for (const expr of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "MON * * * *"]) {
      expect(parseCron(expr), expr).toBeNull();
    }
  });

  it("7 vale domenica come 0", () => {
    expect(parseCron("0 0 * * 7")!.weekdays.has(0)).toBe(true);
  });
});

describe("nextCronTime (ora italiana)", () => {
  it("ogni giorno alle 8 in inverno (UTC+1) e in estate (UTC+2)", () => {
    expect(next("0 8 * * *", "2026-11-24T06:00:00Z")).toBe("2026-11-24T07:00:00.000Z");
    expect(next("0 8 * * *", "2026-11-24T07:00:00Z")).toBe("2026-11-25T07:00:00.000Z");
    expect(next("0 8 * * *", "2026-07-01T05:00:00Z")).toBe("2026-07-01T06:00:00.000Z");
  });

  it("strettamente dopo l'istante dato", () => {
    expect(next("*/15 * * * *", "2026-11-24T10:15:00Z")).toBe("2026-11-24T10:30:00.000Z");
  });

  it("giorni feriali: dal venerdì sera al lunedì", () => {
    // 27/11/2026 è venerdì
    expect(next("0 9 * * 1-5", "2026-11-27T10:00:00Z")).toBe("2026-11-30T08:00:00.000Z");
  });

  it("giorno del mese o della settimana, se entrambi ristretti", () => {
    // 1 dicembre 2026 è martedì; il primo lunedì dopo il 24/11 è il 30/11
    expect(next("0 12 1 * 1", "2026-11-24T12:00:00Z")).toBe("2026-11-30T11:00:00.000Z");
  });

  it("29 febbraio: il prossimo anno bisestile", () => {
    expect(next("0 0 29 2 *", "2026-11-24T00:00:00Z")).toBe("2028-02-28T23:00:00.000Z");
  });

  it("mai: 31 febbraio", () => {
    expect(next("0 0 31 2 *", "2026-11-24T00:00:00Z")).toBeNull();
  });

  it("salto di primavera: un orario che non esiste scatta comunque una volta", () => {
    // 29/03/2026: alle 02:00 l'ora va alle 03:00
    const t = next("30 2 * * *", "2026-03-28T12:00:00Z");
    expect(t).not.toBeNull();
    expect(new Date(t!).getTime()).toBeGreaterThan(new Date("2026-03-28T12:00:00Z").getTime());
    expect(new Date(t!).getTime()).toBeLessThan(new Date("2026-03-29T03:00:00Z").getTime());
  });

  it("ora ripetuta d'autunno: una sola run", () => {
    // 25/10/2026: le 02:30 capitano due volte
    const first = next("30 2 * * *", "2026-10-24T12:00:00Z")!;
    const second = next("30 2 * * *", first)!;
    expect(new Date(second).getTime() - new Date(first).getTime()).toBeGreaterThan(20 * 3600_000);
  });
});

describe("checkCron", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  it("normalizza gli spazi", () => {
    expect(checkCron("  0   8 * * * ", now)).toMatchObject({ ok: true, cron: "0 8 * * *" });
  });
  it("rifiuta le espressioni non valide, che non scattano mai o troppo frequenti", () => {
    expect(checkCron("x", now)).toEqual({ ok: false, reason: "invalid" });
    expect(checkCron("0 0 30 2 *", now)).toEqual({ ok: false, reason: "never" });
    expect(checkCron("* * * * *", now)).toEqual({ ok: false, reason: "tooFrequent" });
    expect(checkCron("0,3 * * * *", now)).toEqual({ ok: false, reason: "tooFrequent" });
    expect(checkCron("*/5 * * * *", now).ok).toBe(true);
  });
});

describe("formatLocal", () => {
  it("data e ora italiane", () => {
    expect(formatLocal(new Date("2026-11-24T07:05:00Z"))).toBe("24/11/2026 08:05");
  });
});
