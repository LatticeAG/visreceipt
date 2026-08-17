import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { VisReceiptError } from "./errors.js";
import { ReceiptLedger, repairLedgerFile, verifyFile } from "./ledger.js";
import { readLedgerFile, repairTail } from "./repair.js";

const SESSION = "ses_11111111-1111-4111-8111-111111111111";

describe("crash tail", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("detects truncated_tail and repair-tail recovers", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-crash-"));
    const path = join(dir, "crash.vrc");
    const ledger = await ReceiptLedger.create(path, { subject_id: SESSION });
    await ledger.append({
      subject_kind: "tool_call",
      subject_id: "evt_1",
      payload: { name: "run" }
    });
    await ledger.close();

    await appendFile(path, '{"kind":"link","seq":');

    const broken = await verifyFile(path);
    expect(broken.ok).toBe(false);
    expect(broken.broken_at?.reason).toBe("truncated_tail");

    await expect(ReceiptLedger.open(path)).rejects.toSatisfy((err: unknown) => {
      return err instanceof VisReceiptError && err.code === "VRC1004";
    });

    const text = await readLedgerFile(path);
    const repaired = repairTail(text);
    expect(repaired.truncated).toBe(true);
    expect(repaired.last_seq).toBe(2);
    expect(repaired.text.endsWith("\n")).toBe(true);
    expect(repaired.text.includes('{"kind":"link","seq":')).toBe(false);
    await writeFile(path, repaired.text, { encoding: "utf8", mode: 0o600 });

    const ok = await verifyFile(path);
    expect(ok.ok).toBe(true);
    expect(ok.seq).toBe(2);
  });

  it("repairLedgerFile rewrites the truncated tail and verify succeeds", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-crash2-"));
    const path = join(dir, "crash.vrc");
    const ledger = await ReceiptLedger.create(path, { subject_id: SESSION });
    await ledger.append({
      subject_kind: "tool_call",
      subject_id: "evt_1"
    });
    await ledger.close();
    await appendFile(path, '{"incomplete":');
    const result = await repairLedgerFile(path);
    expect(result.truncated).toBe(true);
    const ok = await verifyFile(path);
    expect(ok.ok).toBe(true);
  });

  it("does not strip sig on a complete line", () => {
    const complete = '{"seq":1,"sig":"deadbeef"}';
    const repaired = repairTail(`${complete}\n{"kind":"link","trunc`);
    expect(repaired.truncated).toBe(true);
    expect(repaired.text).toBe(`${complete}\n`);
    expect(repaired.text).toContain('"sig":"deadbeef"');
  });
});
