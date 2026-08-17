import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { exportRange, verifyExport } from "./export.js";
import { ReceiptLedger } from "./ledger.js";
import { sidecarPath } from "./paths.js";
import type { SessionData } from "./vrs.js";

const require = createRequire(import.meta.url);
const { VisReplay } = require("@latticeag/visreplay") as {
  VisReplay: new (opts?: { sessionName?: string; agentType?: string }) => {
    recordToolCall(name: string, args: Record<string, unknown>): unknown;
    recordToolResult(result: unknown): unknown;
    end(): SessionData;
    save(path: string): Promise<void>;
    getSession(): SessionData;
  };
};

const SESSION = "ses_11111111-1111-4111-8111-111111111111";

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

async function threeRecordLedger() {
  const ledger = await ReceiptLedger.openMemory({ subject_id: SESSION });
  await ledger.append({
    subject_kind: "tool_call",
    subject_id: "evt_22222222-2222-4222-8222-222222222222",
    payload: { name: "run" }
  });
  await ledger.seal("tool_result", {
    subject_kind: "tool_result",
    subject_id: "evt_33333333-3333-4333-8333-333333333333",
    payload: { visreplay_event_id: "evt_33333333-3333-4333-8333-333333333333" }
  });
  return ledger;
}

describe("exportRange", () => {
  it("exports seq 2-3 without genesis and verifies internally", async () => {
    const ledger = await threeRecordLedger();
    const seq2 = await ledger.inspect(2);
    const slice = await ledger.exportRange(2, 3);
    expect(slice.$schema).toBe("visreceipt/export/1.0");
    expect(slice.from_seq).toBe(2);
    expect(slice.to_seq).toBe(3);
    expect(slice.records).toHaveLength(2);
    expect(slice.record_count).toBe(2);
    expect(slice.records[0]!.seq).toBe(2);
    expect(slice.records[1]!.seq).toBe(3);
    expect(slice.records[0]!.kind).not.toBe("genesis");
    expect(slice.records.some((record) => record.kind === "genesis")).toBe(false);
    expect(slice.start_prev_hash).toBe(seq2.record.prev_hash);
    expect(slice.start_prev_hash).toBe(slice.records[0]!.prev_hash);
    expect(slice.end_hash).toBe(slice.records[1]!.hash);
    const verified = verifyExport(slice);
    expect(verified.ok).toBe(true);
    expect(verified.chain_head).toBe(slice.end_hash);
    await ledger.close();
  });

  it("exportRange helper matches ledger.exportRange", async () => {
    const ledger = await threeRecordLedger();
    const viaClass = await ledger.exportRange(2, 3);
    const loaded = await ledger.inspect(1);
    expect(loaded.record.kind).toBe("genesis");
    const viaFn = await exportRange(
      [loaded.record, (await ledger.inspect(2)).record, (await ledger.inspect(3)).record],
      2,
      3
    );
    expect(viaFn.start_prev_hash).toBe(viaClass.start_prev_hash);
    expect(viaFn.end_hash).toBe(viaClass.end_hash);
    await ledger.close();
  });
});

describe("verify --export", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("exits 0 for the real head and 2 head_mismatch for a wrong head", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-export-cli-"));
    const ledgerPath = join(dir, "t.vrc");
    const eventPath = join(dir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        subject_kind: "tool_call",
        subject_id: "evt_22222222-2222-4222-8222-222222222222",
        payload: { name: "run" }
      }),
      "utf8"
    );
    const sealed = await captureIo(() =>
      runCli([
        "seal",
        "--ledger",
        ledgerPath,
        "--session-id",
        SESSION,
        "--event",
        eventPath
      ])
    );
    expect(sealed.exitCode).toBe(0);
    const verified = await captureIo(() => runCli(["verify", ledgerPath, "--json"]));
    expect(verified.exitCode).toBe(0);
    const body = JSON.parse(verified.stdout) as { seq: number; chain_head: string };
    const slicePath = join(dir, "slice.json");
    const exported = await captureIo(() =>
      runCli([
        "export",
        ledgerPath,
        "--from-seq",
        "1",
        "--to-seq",
        String(body.seq),
        "--out",
        slicePath
      ])
    );
    expect(exported.exitCode).toBe(0);
    const ok = await captureIo(() =>
      runCli(["verify", "--export", slicePath, "--expect-head", body.chain_head])
    );
    expect(ok.exitCode).toBe(0);
    const badHead = "aa".repeat(32);
    const bad = await captureIo(() =>
      runCli(["verify", "--export", slicePath, "--expect-head", badHead])
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("head_mismatch");
  });

  it("verifyExport accepts a sidecar slice whose seals store VRS pointers", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-export-vrs-"));
    const recorder = new VisReplay({ sessionName: "export-vrs", agentType: "custom" });
    recorder.recordToolCall("deploy", { env: "staging" });
    recorder.recordToolResult({ ok: true });
    recorder.end();
    const vrsPath = join(dir, "session.vrs");
    await recorder.save(vrsPath);
    const sealed = await captureIo(() => runCli(["seal", "--from-vrs", vrsPath]));
    expect(sealed.exitCode).toBe(0);
    const ledger = await ReceiptLedger.open(sidecarPath(vrsPath));
    const head = ledger.head();
    const slice = await ledger.exportRange(1, head.seq);
    const verified = verifyExport(slice, { expectedHead: head.hash });
    expect(verified.ok).toBe(true);
    await ledger.close();
  });
});
