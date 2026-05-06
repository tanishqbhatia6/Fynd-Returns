import { describe, it, expect } from "vitest";
import { FYND_ENVIRONMENTS, getFyndBaseUrl, getAppMode } from "../fynd-config.server";

describe("FYND_ENVIRONMENTS", () => {
  it("exposes the canonical prod + uat URLs", () => {
    expect(FYND_ENVIRONMENTS.prod).toBe("https://api.fynd.com");
    expect(FYND_ENVIRONMENTS.uat).toBe("https://api.uat.fyndx1.de");
  });
});

describe("getFyndBaseUrl", () => {
  it("defaults to uat when no environment configured", () => {
    expect(getFyndBaseUrl({})).toBe("https://api.uat.fyndx1.de");
  });

  it("returns prod URL when fyndEnvironment=prod", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: "prod" })).toBe("https://api.fynd.com");
  });

  it("returns uat URL when fyndEnvironment=uat", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: "uat" })).toBe("https://api.uat.fyndx1.de");
  });

  it("falls back to uat for unknown environment values", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: "staging" })).toBe("https://api.uat.fyndx1.de");
  });

  it("honours fyndCustomBaseUrl when set (with http prefix)", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "https://api.custom.example/" })).toBe(
      "https://api.custom.example",
    );
  });

  it("adds https:// prefix to bare domain custom URLs", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "api.custom.example" })).toBe(
      "https://api.custom.example",
    );
  });

  it("strips trailing slash from custom URL origin", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "https://api.custom.example///" })).toBe(
      "https://api.custom.example",
    );
  });

  it("falls back to preset when custom URL is malformed", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "::::not a url", fyndEnvironment: "prod" })).toBe(
      "https://api.fynd.com",
    );
  });

  it("treats empty/whitespace-only custom URL as unset", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "   ", fyndEnvironment: "uat" })).toBe(
      "https://api.uat.fyndx1.de",
    );
  });

  it("handles null settings fields defensively", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: null, fyndCustomBaseUrl: null })).toBe(
      "https://api.uat.fyndx1.de",
    );
  });
});

describe("getAppMode", () => {
  it("returns 'dev' when appMode is 'dev'", () => {
    expect(getAppMode({ appMode: "dev" })).toBe("dev");
  });

  it("is case-insensitive on 'DEV'", () => {
    expect(getAppMode({ appMode: "DEV" })).toBe("dev");
  });

  it("returns 'prod' when appMode is 'prod'", () => {
    expect(getAppMode({ appMode: "prod" })).toBe("prod");
  });

  it("defaults to 'prod' when appMode is unset", () => {
    expect(getAppMode({})).toBe("prod");
  });

  it("defaults to 'prod' for unrecognised modes", () => {
    expect(getAppMode({ appMode: "staging" })).toBe("prod");
  });

  it("handles null appMode", () => {
    expect(getAppMode({ appMode: null })).toBe("prod");
  });
});
