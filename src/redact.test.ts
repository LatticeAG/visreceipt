import { describe, expect, it } from "vitest";

import {
  allowUnredacted,
  DEFAULT_REDACT_KEYS,
  redactText,
  redactValue,
  REDACTED_VALUE
} from "./redact.js";

describe("redact D14", () => {
  it("redacts visreplay and latticeag secret keys including rawText", () => {
    expect(DEFAULT_REDACT_KEYS).toEqual(
      expect.arrayContaining([
        "apiKey",
        "api_key",
        "authorization",
        "Authorization",
        "password",
        "secret",
        "token",
        "rawText"
      ])
    );
    const redacted = redactValue({
      apiKey: "k",
      token: "t",
      Authorization: "Bearer x",
      rawText: "never persist",
      ok: true
    });
    expect(redacted).toEqual({
      apiKey: REDACTED_VALUE,
      token: REDACTED_VALUE,
      Authorization: REDACTED_VALUE,
      rawText: REDACTED_VALUE,
      ok: true
    });
  });

  it("redacts secret-shaped substrings", () => {
    expect(redactText("key sk-abcdefghijklmnopqrst token")).toContain(REDACTED_VALUE);
    expect(redactText("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED_VALUE);
  });

  it("allowUnredacted requires a TTY and VISRECEIPT_ALLOW_UNREDACTED=1", () => {
    expect(allowUnredacted({ tty: true, env: { VISRECEIPT_ALLOW_UNREDACTED: "1" } })).toBe(true);
    expect(allowUnredacted({ tty: false, env: { VISRECEIPT_ALLOW_UNREDACTED: "1" } })).toBe(false);
    expect(allowUnredacted({ tty: true, env: {} })).toBe(false);
  });
});
