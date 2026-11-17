import { describe, expect, it } from "vitest";
import { readReleaseArgs, releaseStatusText, workLed, workStatusLabel } from "./work-status";

describe("workLed", () => {
  it("un LED per stato del lavoro", () => {
    expect(workLed("open")).toBe("work");
    expect(workLed("awaiting_release")).toBe("ask");
    expect(workLed("releasing")).toBe("work");
    expect(workLed("released")).toBe("ok");
    expect(workLed("abandoned")).toBe("idle");
  });
});

describe("workStatusLabel", () => {
  it("frasi per stato", () => {
    expect(workStatusLabel("open")).toBe("in corso");
    expect(workStatusLabel("awaiting_release")).toBe("in prova: da portare in produzione");
    expect(workStatusLabel("releasing")).toBe("in attesa della CI della PR di rilascio");
    expect(workStatusLabel("released")).toBe("in produzione");
    expect(workStatusLabel("abandoned")).toBe("abbandonato");
  });
});

describe("readReleaseArgs", () => {
  it("legge i dati pubblici della voce e scarta i link non https", () => {
    const r = readReleaseArgs({
      number: 2,
      repo: "o/r",
      branch: "botcave/lavoro-1-2",
      baseBranch: "main",
      headSha: "abcdef1234",
      stagingBranch: "staging",
      stagingUrl: "https://prova.example",
      stagingNote: null,
      tasks: [
        { id: "t1", title: "Login", issue: 4, prNumber: 7, prUrl: "https://github.com/o/r/pull/7" },
        { id: "t2", title: "Logout", issue: null, prNumber: 8, prUrl: "javascript:alert(1)" },
        "rotto",
      ],
      postScripts: ["docs/migrations/2026-11-17-x-post.sql", 3],
    });
    expect(r).toEqual({
      number: 2,
      repo: "o/r",
      branch: "botcave/lavoro-1-2",
      baseBranch: "main",
      headSha: "abcdef1234",
      stagingBranch: "staging",
      stagingUrl: "https://prova.example",
      stagingNote: null,
      tasks: [
        { id: "t1", title: "Login", issue: 4, prNumber: 7, prUrl: "https://github.com/o/r/pull/7" },
        { id: "t2", title: "Logout", issue: null, prNumber: 8, prUrl: null },
      ],
      postScripts: ["docs/migrations/2026-11-17-x-post.sql"],
    });
  });

  it("argomenti assenti: valori vuoti", () => {
    expect(readReleaseArgs(null)).toMatchObject({ number: null, tasks: [], postScripts: [], stagingUrl: null });
  });
});

describe("releaseStatusText", () => {
  it("voce in esecuzione: in attesa della CI", () => {
    expect(releaseStatusText("executing")).toBe("in attesa della CI della PR di rilascio");
    expect(releaseStatusText("pending")).toBeNull();
  });
});
