import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_SESSION_EVENTS,
  DEFAULT_MAX_SESSION_FILE_BYTES,
  hashVrsEvent,
  loadVrs,
  SESSION_SCHEMA
} from "./vrs.js";

const MIN_SESSION = {
  $schema: SESSION_SCHEMA,
  sessionId: "ses_11111111-1111-4111-8111-111111111111",
  sessionName: "load-test",
  agentType: "custom",
  startedAt: "2026-08-17T14:48:00.000Z",
  events: [
    {
      eventId: "evt_1",
      index: 0,
      timestamp: "2026-08-17T14:48:00.100Z",
      type: "tool_call",
      name: "run",
      arguments: { x: 1 }
    }
  ]
};

describe("loadVrs", () => {
  it("parses visreplay/session/1.0 without the visreplay package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrs-load-"));
    const path = join(dir, "session.vrs");
    await writeFile(path, `${JSON.stringify(MIN_SESSION, null, 2)}\n`, "utf8");
    const session = await loadVrs(path);
    expect(session.$schema).toBe(SESSION_SCHEMA);
    expect(session.sessionId).toBe(MIN_SESSION.sessionId);
    expect(session.events).toHaveLength(1);
    expect(session.events[0]?.type).toBe("tool_call");
  });

  it("rejects files over maxFileBytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrs-big-"));
    const path = join(dir, "session.vrs");
    await writeFile(path, `${JSON.stringify(MIN_SESSION)}\n`, "utf8");
    await expect(loadVrs(path, { maxFileBytes: 16 })).rejects.toThrow(/exceeds/);
  });

  it("rejects event lists over maxEvents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrs-ev-"));
    const path = join(dir, "session.vrs");
    const many = {
      ...MIN_SESSION,
      events: [
        MIN_SESSION.events[0],
        { ...MIN_SESSION.events[0], eventId: "evt_2", index: 1 }
      ]
    };
    await writeFile(path, `${JSON.stringify(many)}\n`, "utf8");
    await expect(loadVrs(path, { maxEvents: 1 })).rejects.toThrow(/exceeding/);
  });

  it("hashes the event object as stored", () => {
    const event = MIN_SESSION.events[0];
    expect(hashVrsEvent(event)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVrsEvent(event)).toBe(hashVrsEvent({ ...event }));
  });

  it("exports visreplay default caps", () => {
    expect(DEFAULT_MAX_SESSION_EVENTS).toBe(500000);
    expect(DEFAULT_MAX_SESSION_FILE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("rejects a directory path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrs-dir-"));
    await mkdir(join(dir, "nested"));
    await expect(loadVrs(join(dir, "nested"))).rejects.toThrow();
  });
});
