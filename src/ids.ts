import { randomBytes, randomUUID } from "node:crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;

export function isHex64(value: string): boolean {
  return HEX64_RE.test(value);
}

export function createLedgerId(): string {
  return `led_${randomUUID()}`;
}

export function ledgerIdFromSessionId(sessionId: string): string {
  const stripped = sessionId.startsWith("ses_") ? sessionId.slice(4) : sessionId;
  if (UUID_RE.test(stripped)) {
    return `led_${stripped}`;
  }
  const prefixed = `led_${stripped}`;
  return prefixed.slice(0, 128);
}

export function createNonce(): string {
  return randomBytes(16).toString("hex");
}
