import { afterEach, describe, expect, it } from "vitest";
import { appBaseDomain, appTemplateRepo } from "./config";

afterEach(() => {
  delete process.env["APP_TEMPLATE_REPO"];
  delete process.env["APP_BASE_DOMAIN"];
});

describe("config", () => {
  it("valori predefiniti", () => {
    expect(appTemplateRepo()).toBe("TwentIvan/botcave-modello-app");
    expect(appBaseDomain()).toBe("fantamister.cloud");
  });
  it("variabili d'ambiente", () => {
    process.env["APP_TEMPLATE_REPO"] = "Org/modello";
    process.env["APP_BASE_DOMAIN"] = "Example.com";
    expect(appTemplateRepo()).toBe("Org/modello");
    expect(appBaseDomain()).toBe("example.com");
  });
});
