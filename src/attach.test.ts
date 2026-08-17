import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { attachReceipts, sealFromSession, sidecarPath } from "./attach.js";
import { runCli } from "./cli.js";
import { VisReceiptError } from "./errors.js";
import { verifyFile } from "./ledger.js";
import { collectRotationRun } from "./rotate.js";
import { loadVrs } from "./vrs.js";
import type { SessionData } from "./vrs.js";

const require = createRequire(import.meta.url);
const { VisReplay } = require("@latticeag/visreplay") as {
  VisReplay: new (opts?: { sessionName?: string; agentType?: string }) => {
    recordToolCall(name: string, args: Record<string, unknown>): unknown;
    recordToolResult(result: unknown): unknown;
    end(): SessionData;
    save(path: string): Promise<void>;
    getSession(): SessionData;
    wrap<T extends object>(agent: T): T;
  };
};

const here = dirname(fileURLToPath(import.meta.url));
const t09 = JSON.parse(
  readFileSync(join(here, "..", "conformance", "tamper", "T09.json"), "utf8")
) as { seq: number; reason: string };

async function captureIo(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const prevExit = process.exitCode;
  try {
    await fn();
    const code = process.exitCode;
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode: typeof code === "number" ? code : 0
    };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    process.exitCode = prevExit ?? 0;
  }
}

async function recordSession(dir: string, ended = true): Promise<{
  vrsPath: string;
  recorder: InstanceType<typeof VisReplay>;
}> {
  const recorder = new VisReplay({ sessionName: "p3-sidecar", agentType: "custom" });
  recorder.recordToolCall("deploy", { env: "staging" });
  recorder.recordToolResult({ ok: true, status: "done" });
  if (ended) {
    recorder.end();
  }
  const vrsPath = join(dir, "session.vrs");
  await recorder.save(vrsPath);
  return { vrsPath, recorder };
}

describe("VisReplay sidecar", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    dirs.length = 0;
  });

  it("seals a real VisReplay session and verifies with payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrc-p3-"));
    dirs.push(dir);
    const { vrsPath } = await recordSession(dir);
    const sidecar = sidecarPath(vrsPath);
    const sealed = await captureIo(() => runCli(["seal", "--from-vrs", vrsPath]));
    expect(sealed.exitCode).toBe(0);
    expect(sealed.stdout).toMatch(/^sealed seq=\d+ head=[0-9a-f]{64} receipt_id=rcp_/);
    const verified = await verifyFile(sidecar);
    expect(verified.ok).toBe(true);
    const cliVerify = await captureIo(() =>
      runCli(["verify", sidecar, "--with-payload", "--vrs", vrsPath])
    );
    expect(cliVerify.exitCode).toBe(0);
  });

  it("T09: edited tool_result.result fails --with-payload at the seal seq", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrc-t09-"));
    dirs.push(dir);
    const { vrsPath } = await recordSession(dir);
    const sidecar = sidecarPath(vrsPath);
    await captureIo(() => runCli(["seal", "--from-vrs", vrsPath]));
    const session = JSON.parse(await readFile(vrsPath, "utf8")) as SessionData;
    const toolResult = session.events.find((event) => event.type === "tool_result");
    expect(toolResult).toBeDefined();
    toolResult!.result = { ok: false, tampered: true };
    await writeFile(vrsPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

    const result = await captureIo(() =>
      runCli(["verify", sidecar, "--with-payload", "--vrs", vrsPath, "--json"])
    );
    expect(result.exitCode).toBe(4);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      broken_at: { reason: string; seq: number };
    };
    expect(body.ok).toBe(false);
    expect(body.broken_at.reason).toBe("payload_mismatch");
    expect(body.broken_at.seq).toBe(t09.seq);
    expect(t09.reason).toBe("payload_mismatch");
  });

  it("T13: mutating an old event on re-save throws VRC2010 and poisons the ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrc-t13-"));
    dirs.push(dir);
    const recorder = new VisReplay({ sessionName: "t13", agentType: "custom" });
    attachReceipts(recorder);
    recorder.recordToolCall("deploy", { env: "staging" });
    recorder.recordToolResult({ ok: true });
    recorder.end();
    const vrsPath = join(dir, "session.vrs");
    await recorder.save(vrsPath);
    const sidecar = sidecarPath(vrsPath);

    const mutated = structuredClone(recorder.getSession()) as SessionData;
    const old = mutated.events.find((event) => event.type === "tool_result");
    expect(old).toBeDefined();
    old!.result = { ok: false, mutated: true };

    await expect(sealFromSession(mutated, sidecar)).rejects.toSatisfy((err: unknown) => {
      return err instanceof VisReceiptError && err.code === "VRC2010";
    });
    await expect(sealFromSession(mutated, sidecar)).rejects.toSatisfy((err: unknown) => {
      return err instanceof VisReceiptError && err.code === "VRC2010";
    });
    await expect(recorder.save(vrsPath)).rejects.toSatisfy((err: unknown) => {
      return err instanceof VisReceiptError && err.code === "VRC2010";
    });
  });

  it("emits receipt_issued on genesis and seals, never session_recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrc-emit-"));
    dirs.push(dir);
    const names: string[] = [];
    const recorder = new VisReplay({ sessionName: "emit", agentType: "custom" });
    attachReceipts(recorder, {
      emit: (envelope) => {
        names.push((envelope as { name: string }).name);
      }
    });
    recorder.recordToolCall("ping", {});
    recorder.recordToolResult({ pong: true });
    recorder.end();
    await recorder.save(join(dir, "session.vrs"));
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.every((name) => name === "receipt_issued")).toBe(true);
    expect(names).not.toContain("session_recorded");
  });

  it("skips wrap input/output by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrc-wrap-"));
    dirs.push(dir);
    const recorder = new VisReplay({ sessionName: "wrap", agentType: "custom" });
    const agent = recorder.wrap({
      run(task: string) {
        return `did ${task}`;
      }
    });
    agent.run("hello");
    recorder.recordToolCall("x", {});
    recorder.recordToolResult({ y: 1 });
    recorder.end();
    const vrsPath = join(dir, "session.vrs");
    await recorder.save(vrsPath);
    const session = await loadVrs(vrsPath);
    expect(session.events.some((event) => event.type === "input")).toBe(true);
    const sidecar = sidecarPath(vrsPath);
    await sealFromSession(session, sidecar, { source_path: vrsPath });
    const run = await collectRotationRun(sidecar);
    const kinds = run.records.map((rec) => rec.subject_kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).not.toContain("session_event");
  });

  it("attachReceipts is idempotent", () => {
    const recorder = new VisReplay({ sessionName: "once", agentType: "custom" });
    const once = attachReceipts(recorder);
    const twice = attachReceipts(recorder);
    expect(once).toBe(twice);
    expect(once).toBe(recorder);
  });

  it("does not write session_end until endedAt is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrc-open-"));
    dirs.push(dir);
    const { vrsPath } = await recordSession(dir, false);
    const sidecar = sidecarPath(vrsPath);
    await sealFromSession(await loadVrs(vrsPath), sidecar, { source_path: vrsPath });
    const openRun = await collectRotationRun(sidecar);
    expect(openRun.records.some((rec) => rec.freeze_point === "session_end")).toBe(false);
    expect(openRun.records.some((rec) => rec.freeze_point === "session_start")).toBe(true);
    expect(openRun.records.some((rec) => rec.freeze_point === "tool_result")).toBe(true);
  });
});
