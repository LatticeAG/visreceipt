import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";

import { canonicalize, sha256Hex } from "./jcs.js";
import type { JsonValue } from "./types.js";

export const SESSION_SCHEMA = "visreplay/session/1.0" as const;
export const DEFAULT_MAX_SESSION_EVENTS = 500_000;
export const DEFAULT_MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export const VRS_EVENT_TYPES = [
  "input",
  "reasoning",
  "tool_call",
  "tool_result",
  "output",
  "error"
] as const;

export type VrsEventType = (typeof VRS_EVENT_TYPES)[number] | string;

export interface VrsEvent {
  eventId: string;
  index: number;
  timestamp: string;
  type: VrsEventType;
  content?: JsonValue;
  name?: string;
  arguments?: Record<string, JsonValue>;
  result?: JsonValue;
  error?: string;
  method?: string;
  metadata?: Record<string, JsonValue>;
  [key: string]: JsonValue | undefined;
}

export interface SessionData {
  $schema: typeof SESSION_SCHEMA | string;
  sessionId: string;
  sessionName: string;
  agentType: string;
  startedAt: string;
  endedAt?: string;
  events: VrsEvent[];
}

export interface LoadVrsOptions {
  maxFileBytes?: number;
  maxEvents?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid session: ${label} must be a non-empty string`);
  }
  return value;
}

function parseEvent(value: unknown, index: number): VrsEvent {
  if (!isRecord(value)) {
    throw new Error(`invalid session: events[${index}] must be an object`);
  }
  const eventId = requireString(value.eventId, `events[${index}].eventId`);
  if (typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0) {
    throw new Error(`invalid session: events[${index}].index must be a non-negative integer`);
  }
  const timestamp = requireString(value.timestamp, `events[${index}].timestamp`);
  const type = requireString(value.type, `events[${index}].type`);
  return value as unknown as VrsEvent & { eventId: string; timestamp: string; type: string };
}

export function eventAsStored(event: unknown): JsonValue {
  return JSON.parse(JSON.stringify(event)) as JsonValue;
}

export function hashVrsEvent(event: unknown): string {
  return sha256Hex(canonicalize(eventAsStored(event)));
}

export async function loadVrs(path: string, opts?: LoadVrsOptions): Promise<SessionData> {
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_SESSION_FILE_BYTES;
  const maxEvents = opts?.maxEvents ?? DEFAULT_MAX_SESSION_EVENTS;
  let bytes: Buffer;
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      throw new Error("path is not a regular file");
    }
    if (st.size > maxFileBytes) {
      throw new Error(`file size ${st.size} bytes exceeds the ${maxFileBytes}-byte limit`);
    }
    bytes = await readFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read session file "${path}": ${message}`);
  }
  if (bytes.byteLength > maxFileBytes) {
    throw new Error(
      `Invalid VisReplay session in "${path}": file size ${bytes.byteLength} bytes exceeds the ${maxFileBytes}-byte limit`
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid UTF-8 in session file "${path}": ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in session file "${path}": ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid VisReplay session in "${path}": expected a JSON object`);
  }
  if (parsed.$schema !== SESSION_SCHEMA) {
    throw new Error(`Invalid VisReplay session in "${path}": expected $schema "${SESSION_SCHEMA}"`);
  }
  if (!Array.isArray(parsed.events)) {
    throw new Error(`Invalid VisReplay session in "${path}": events must be an array`);
  }
  if (parsed.events.length > maxEvents) {
    throw new Error(
      `Invalid VisReplay session in "${path}": events array has ${parsed.events.length} entries, exceeding the ${maxEvents}-event limit`
    );
  }
  const events = parsed.events.map((event, index) => parseEvent(event, index));
  const session: SessionData = {
    $schema: SESSION_SCHEMA,
    sessionId: requireString(parsed.sessionId, "sessionId"),
    sessionName: requireString(parsed.sessionName, "sessionName"),
    agentType: requireString(parsed.agentType, "agentType"),
    startedAt: requireString(parsed.startedAt, "startedAt"),
    events
  };
  if (parsed.endedAt !== undefined) {
    session.endedAt = requireString(parsed.endedAt, "endedAt");
  }
  return session;
}
