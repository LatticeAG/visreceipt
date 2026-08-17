import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { inspectLedger } from "./inspect.js";
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

describe("inspect", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("inspect --head matches verify --json seq, chain_head, and ledger_id", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-inspect-"));
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
    const body = JSON.parse(verified.stdout) as {
      seq: number;
      chain_head: string;
      ledger_id: string;
    };
    const inspected = await captureIo(() => runCli(["inspect", ledgerPath, "--head"]));
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout).toContain(`seq=${body.seq}`);
    expect(inspected.stdout).toContain(`hash=${body.chain_head}`);
    expect(inspected.stdout).toContain(`ledger_id=${body.ledger_id}`);
    expect(inspected.stdout).toMatch(/receipt_id=rcp_/);
  });

  it("looks up by receipt_id and seq", async () => {
    const ledger = await ReceiptLedger.openMemory({ subject_id: SESSION });
    const link = await ledger.append({
      subject_kind: "tool_call",
      subject_id: "evt_1",
      payload: { name: "run" }
    });
    const byId = await ledger.inspect(link.receipt_id);
    const bySeq = await inspectLedger(
      [(await ledger.inspect(1)).record, link],
      2
    );
    expect(byId.record.seq).toBe(2);
    expect(byId.prev_seq).toBe(1);
    expect(byId.next_seq).toBeNull();
    expect(bySeq.record.receipt_id).toBe(link.receipt_id);
    await ledger.close();
  });
});
