import type { JsonObject, JsonValue } from "./types.js";

export const REDACTED_VALUE = "[REDACTED]" as const;

export const DEFAULT_REDACT_KEYS = [
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "password",
  "secret",
  "token",
  "rawText"
] as const;

export const DEFAULT_REDACT_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
]);

const KEY_SET = new Set(DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase()));

export interface UnredactGate {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function allowUnredacted(gate?: UnredactGate): boolean {
  const tty = gate?.tty ?? Boolean(process.stdin.isTTY);
  const env = gate?.env ?? process.env;
  return tty === true && env.VISRECEIPT_ALLOW_UNREDACTED === "1";
}

function shouldRedactKey(key: string): boolean {
  if (KEY_SET.has(key.toLowerCase())) {
    return true;
  }
  return DEFAULT_REDACT_PATTERNS.some((pattern) => testPattern(pattern, key));
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  try {
    return pattern.test(value);
  } finally {
    pattern.lastIndex = 0;
  }
}

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of DEFAULT_REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    try {
      redacted = redacted.replace(pattern, REDACTED_VALUE);
    } finally {
      pattern.lastIndex = 0;
    }
  }
  return redacted;
}

export function redactValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    out[key] = shouldRedactKey(key) ? REDACTED_VALUE : redactValue(value[key]!);
  }
  return out;
}

export function redactForEmbed(value: JsonValue): JsonValue {
  return redactValue(value);
}
