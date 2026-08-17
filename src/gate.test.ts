import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { assertSealed } from "./gate.js";
import { VisReceiptError } from "./errors.js";
import { ReceiptLedger } from "./ledger.js";

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

describe("gate", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("missing freeze gate exits 5 and session_end gate exits 0", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-gate-"));
    const ledgerPath = join(dir, "t.vrc");
    const linkPath = join(dir, "link.json");
    const endPath = join(dir, "end.json");
    await writeFile(
      linkPath,
      JSON.stringify({
        subject_kind: "tool_call",
        subject_id: "evt_22222222-2222-4222-8222-222222222222",
        payload: { name: "run" }
      }),
      "utf8"
    );
    await writeFile(
      endPath,
      JSON.stringify({
        subject_kind: "session",
        subject_id: SESSION
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
        linkPath
      ])
    );
    expect(sealed.exitCode).toBe(0);

    const missing = await captureIo(() =>
      runCli(["gate", "--ledger", ledgerPath, "--subject-id", SESSION])
    );
    expect(missing.exitCode).toBe(5);
    expect(missing.stderr).toContain("VRC2001");

    const endSeal = await captureIo(() =>
      runCli([
        "seal",
        "--ledger",
        ledgerPath,
        "--event",
        endPath,
        "--freeze-point",
        "session_end"
      ])
    );
    expect(endSeal.exitCode).toBe(0);

    const gated = await captureIo(() =>
      runCli([
        "gate",
        "--ledger",
        ledgerPath,
        "--subject-id",
        SESSION,
        "--freeze-point",
        "session_end"
      ])
    );
    expect(gated.exitCode).toBe(0);
    expect(gated.stdout).toMatch(/^sealed seq=/);
  });

  it("assertSealed throws VRC2001 when the freeze is absent", async () => {
    const ledger = await ReceiptLedger.openMemory({ subject_id: SESSION });
    await ledger.append({
      subject_kind: "tool_call",
      subject_id: "evt_1"
    });
    await expect(assertSealed(ledger, { subject_id: SESSION })).rejects.toSatisfy(
      (err: unknown) => err instanceof VisReceiptError && err.code === "VRC2001"
    );
    const end = await ledger.seal("session_end", {
      subject_kind: "session",
      subject_id: SESSION
    });
    const got = await assertSealed(ledger, {
      freeze_point: "session_end",
      subject_id: SESSION
    });
    expect(got.receipt_id).toBe(end.receipt_id);
    await ledger.close();
  });
});
