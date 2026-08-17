import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReceiptLedger, verifyFile } from "./ledger.js";
import { parseLedgerText } from "./parse.js";
import { readLedgerFile } from "./repair.js";

const SESSION = "ses_11111111-1111-4111-8111-111111111111";

describe("rotation", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("rotates at max_records 4 and continuation prev_hash matches rotation hash", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-rot-"));
    const path = join(dir, "foo.vrc");
    const rotated = join(dir, "foo.vrc.2");
    const ledger = await ReceiptLedger.create(
      path,
      { subject_id: SESSION },
      { max_records: 4 }
    );
    try {
      for (let i = 0; i < 8; i++) {
        await ledger.append({
          subject_kind: "tool_call",
          subject_id: `evt_${i}`
        });
        if (existsSync(rotated)) {
          break;
        }
      }
    } finally {
      await ledger.close();
    }
    expect(existsSync(rotated)).toBe(true);

    const first = parseLedgerText(await readLedgerFile(path));
    const second = parseLedgerText(await readLedgerFile(rotated));
    expect("records" in first).toBe(true);
    expect("records" in second).toBe(true);
    if (!("records" in first) || !("records" in second)) {
      throw new Error("parse failed");
    }
    const rotation = first.records.find((r) => r.kind === "rotation");
    const continuation = second.records.find((r) => r.kind === "continuation");
    expect(rotation).toBeDefined();
    expect(continuation).toBeDefined();
    expect(continuation?.prev_hash).toBe(rotation?.hash);
    expect(rotation?.next_path).toBe("foo.vrc.2");
    expect(rotation?.payload).toMatchObject({ next_path: "foo.vrc.2" });
    expect(continuation?.payload).toMatchObject({ prev_file: "foo.vrc" });

    const verified = await verifyFile(path);
    expect(verified.ok).toBe(true);
    expect(verified.files_walked).toHaveLength(2);
  });
});
