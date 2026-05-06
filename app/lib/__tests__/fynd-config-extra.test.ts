import { describe, it, expect } from "vitest";
import { FYND_ENVIRONMENTS, getFyndBaseUrl, getAppMode } from "../fynd-config.server";

describe("FYND_ENVIRONMENTS extra", () => {
  it("only exposes the prod and uat keys", () => {
    expect(Object.keys(FYND_ENVIRONMENTS).sort()).toEqual(["prod", "uat"]);
  });

  it("uses https for both environments", () => {
    for (const url of Object.values(FYND_ENVIRONMENTS)) {
      expect(url.startsWith("https://")).toBe(true);
      expect(url.endsWith("/")).toBe(false);
    }
  });
});

describe("getFyndBaseUrl extra branches", () => {
  it("trims surrounding whitespace from custom URL before parsing", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "   https://api.custom.example   " })).toBe(
      "https://api.custom.example",
    );
  });

  it("strips path components from custom URL keeping only the origin", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "https://api.custom.example/v1/foo/bar" })).toBe(
      "https://api.custom.example",
    );
  });

  it("preserves explicit non-default ports in custom URL origin", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "https://api.custom.example:8443/x" })).toBe(
      "https://api.custom.example:8443",
    );
  });

  it("preserves http (not https) when supplied explicitly in custom URL", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "http://localhost:3001/api" })).toBe(
      "http://localhost:3001",
    );
  });

  it("retains the upgraded https scheme for bare host with port", () => {
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "api.custom.example:9000" })).toBe(
      "https://api.custom.example:9000",
    );
  });

  it("falls back to uat when custom URL parses to an empty origin", () => {
    // `https://` alone is technically parseable but has empty host
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "https://" })).toBe("https://api.uat.fyndx1.de");
  });

  it("custom URL takes precedence over fyndEnvironment=prod", () => {
    expect(
      getFyndBaseUrl({
        fyndCustomBaseUrl: "https://api.custom.example",
        fyndEnvironment: "prod",
      }),
    ).toBe("https://api.custom.example");
  });

  it("treats undefined settings.fyndEnvironment same as missing (uat)", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: undefined })).toBe("https://api.uat.fyndx1.de");
  });

  it("falls back to uat when fyndEnvironment is empty string", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: "" })).toBe("https://api.uat.fyndx1.de");
  });

  it("returns uat for unknown env even when custom URL is malformed and unset", () => {
    expect(getFyndBaseUrl({ fyndEnvironment: "qa", fyndCustomBaseUrl: "" })).toBe(
      "https://api.uat.fyndx1.de",
    );
  });

  it("supports custom URL with userinfo by extracting bare origin", () => {
    // userinfo is dropped from origin
    expect(getFyndBaseUrl({ fyndCustomBaseUrl: "https://user:pass@api.custom.example/path" })).toBe(
      "https://api.custom.example",
    );
  });
});

describe("getAppMode extra branches", () => {
  it("treats whitespace-padded 'dev' as not exactly 'dev' (returns prod)", () => {
    // implementation only lower-cases; trailing spaces shouldn't equal "dev"
    expect(getAppMode({ appMode: "dev " })).toBe("prod");
  });

  it("returns 'prod' for empty string appMode", () => {
    expect(getAppMode({ appMode: "" })).toBe("prod");
  });

  it("returns 'prod' for the string 'production'", () => {
    expect(getAppMode({ appMode: "production" })).toBe("prod");
  });

  it("returns 'prod' for partial-match strings like 'devel'", () => {
    expect(getAppMode({ appMode: "devel" })).toBe("prod");
  });

  it("handles mixed-case 'Dev' as dev", () => {
    expect(getAppMode({ appMode: "Dev" })).toBe("dev");
  });

  it("returns 'prod' for undefined appMode", () => {
    expect(getAppMode({ appMode: undefined })).toBe("prod");
  });
});
