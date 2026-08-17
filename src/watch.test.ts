import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldSkipWatchName, WatchController } from "./watch.js";

describe("watch debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces two rapid writes into one seal after 200ms", async () => {
    vi.useFakeTimers();
    const sealed: string[] = [];
    const controller = new WatchController("/tmp/sessions", {
      debounceMs: 200,
      stat: async () => ({ size: 128, mtimeMs: 1_000 }),
      seal: async (path) => {
        sealed.push(path);
        return { seq: 3, hash: "ab".repeat(32) };
      },
      stderr: () => undefined
    });
    controller.note("session.vrs");
    controller.note("session.vrs");
    expect(sealed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(199);
    expect(sealed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toBe("/tmp/sessions/session.vrs");
    controller.close();
  });

  it("skips size 0, tmp files, and non-vrs names", async () => {
    vi.useFakeTimers();
    const sealed: string[] = [];
    const controller = new WatchController("/tmp/sessions", {
      debounceMs: 200,
      stat: async () => ({ size: 0, mtimeMs: 1_000 }),
      seal: async (path) => {
        sealed.push(path);
        return { seq: 1, hash: "cd".repeat(32) };
      },
      stderr: () => undefined
    });
    expect(shouldSkipWatchName("notes.txt")).toBe(true);
    expect(shouldSkipWatchName("session.vrs.abc.tmp")).toBe(true);
    expect(shouldSkipWatchName(".session.vrs.uuid.tmp")).toBe(true);
    expect(shouldSkipWatchName("session.vrs")).toBe(false);
    controller.note("notes.txt");
    controller.note("session.vrs.abc.tmp");
    controller.note("session.vrs");
    await vi.advanceTimersByTimeAsync(200);
    expect(sealed).toHaveLength(0);
    controller.close();
  });

  it("prints VRC2013 when an in-flight seal fails", async () => {
    vi.useFakeTimers();
    const err: string[] = [];
    const controller = new WatchController("/tmp/sessions", {
      debounceMs: 200,
      stat: async () => ({ size: 64, mtimeMs: 2_000 }),
      seal: async () => {
        throw new Error("boom");
      },
      stderr: (text) => {
        err.push(text);
      }
    });
    controller.note("session.vrs");
    await vi.advanceTimersByTimeAsync(200);
    expect(err.some((line) => line.includes("VRC2013"))).toBe(true);
    controller.close();
  });
});
