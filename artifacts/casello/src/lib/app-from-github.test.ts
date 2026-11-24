import { describe, expect, it } from "vitest";
import { appNameFromRepo, repoKey, slugPreview, suggestedBaseUrl, unregisteredRepos } from "./app-from-github";

const repo = (fullName: string, installationId = 1) => ({ installationId, fullName, defaultBranch: "main", private: true });

describe("app-from-github", () => {
  it("propone il nome dal repository", () => {
    expect(appNameFromRepo("TwentIvan/the-hub-up")).toBe("The Hub Up");
    expect(appNameFromRepo("TwentIvan/Casello-Agent-Hub")).toBe("Casello Agent Hub");
    expect(appNameFromRepo("org/remove_app.web")).toBe("Remove App Web");
    expect(appNameFromRepo("org/mister")).toBe("Mister");
  });

  it("calcola lo slug come il server", () => {
    expect(slugPreview("The Hub Up")).toBe("the-hub-up");
    expect(slugPreview("  Città  ")).toBe("citt");
    expect(slugPreview("---")).toBe("app");
  });

  it("propone la base URL dallo slug", () => {
    expect(suggestedBaseUrl("The Hub Up")).toBe("https://the-hub-up.fantamister.cloud");
    expect(suggestedBaseUrl("Mister", "example.org")).toBe("https://mister.example.org");
  });

  it("esclude i repository già collegati a un'App e ordina per nome", () => {
    const repos = [repo("TwentIvan/vimini"), repo("TwentIvan/mister"), repo("TwentIvan/The-Hub-Up", 2)];
    const apps = [{ sourceRepo: "twentivan/the-hub-up" }, { sourceRepo: null }];
    expect(unregisteredRepos(repos, apps).map((r) => r.fullName)).toEqual(["TwentIvan/mister", "TwentIvan/vimini"]);
  });

  it("distingue lo stesso repository in installazioni diverse", () => {
    expect(repoKey(repo("a/b", 1))).not.toBe(repoKey(repo("a/b", 2)));
  });
});
