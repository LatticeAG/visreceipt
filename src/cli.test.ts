import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";

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

describe("CLI seal and verify", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("seals then verifies a temp ledger", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-cli-"));
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
        "ses_11111111-1111-4111-8111-111111111111",
        "--event",
        eventPath
      ])
    );
    expect(sealed.exitCode).toBe(0);
    expect(sealed.stdout).toMatch(/^sealed seq=\d+ head=[0-9a-f]{64} receipt_id=rcp_/);

    const verified = await captureIo(() => runCli(["verify", ledgerPath]));
    expect(verified.exitCode).toBe(0);
    expect(verified.stderr).toBe("");
  });

  it("fails creating a ledger without --session-id", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-cli-miss-"));
    const ledgerPath = join(dir, "missing.vrc");
    const eventPath = join(dir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({ subject_kind: "tool_call", subject_id: "evt_1" }),
      "utf8"
    );
    const result = await captureIo(() =>
      runCli(["seal", "--ledger", ledgerPath, "--event", eventPath])
    );
    expect(result.exitCode).toBe(1);
  });

  it("T10: honest rewrite verifies, --expect-head of the old head exits 2 head_mismatch", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-t10-"));
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "conformance",
      "tamper",
      "T10.json"
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      ndjson: string;
      expect_head: string;
    };
    const ledgerPath = join(dir, "t10.vrc");
    await writeFile(ledgerPath, fixture.ndjson, "utf8");
    const honest = await captureIo(() => runCli(["verify", ledgerPath]));
    expect(honest.exitCode).toBe(0);
    const headed = await captureIo(() =>
      runCli(["verify", ledgerPath, "--expect-head", fixture.expect_head])
    );
    expect(headed.exitCode).toBe(2);
    expect(headed.stderr).toContain("head_mismatch");
  });

  it("doctor exits 0 and prints ok", async () => {
    const result = await captureIo(() => runCli(["doctor"]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stdout).not.toMatch(/secret|webhook|AXION/i);
  });
});
