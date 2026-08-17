import { afterEach, describe, expect, it } from "vitest";

import { VisReceiptError } from "./errors.js";
import { ReceiptLedger } from "./ledger.js";
import type { ReceiptRecord } from "./types.js";

const SESSION = "ses_11111111-1111-4111-8111-111111111111";

describe("ReceiptLedger", () => {
  afterEach(() => {
    // NODE_ENV is restored in the production test itself
  });

  it("creates memory genesis, appends a link, seals tool_result, and verifies", async () => {
    const emitted: Array<{ name: string; payload?: { seq?: number } }> = [];
    const ledger = await ReceiptLedger.openMemory(
      { subject_id: SESSION },
      {
        emit: (envelope) => {
          emitted.push(envelope as { name: string; payload?: { seq?: number } });
        }
      }
    );
    const link = await ledger.append({
      subject_kind: "tool_call",
      subject_id: "evt_22222222-2222-4222-8222-222222222222",
      payload: { name: "run" }
    });
    const seal = await ledger.seal("tool_result", {
      subject_kind: "tool_result",
      subject_id: "evt_33333333-3333-4333-8333-333333333333",
      payload: { visreplay_event_id: "evt_33333333-3333-4333-8333-333333333333" }
    });
    const verified = await ledger.verify();
    expect(verified.ok).toBe(true);
    expect(verified.seq).toBe(3);
    expect(link.kind).toBe("link");
    expect(link.freeze_point).toBe("event");
    expect(link.payload).toBeUndefined();
    expect(seal.kind).toBe("seal");
    expect(seal.freeze_point).toBe("tool_result");
    expect("sig" in link).toBe(false);
    expect("sig" in seal).toBe(false);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.name).toBe("receipt_issued");
    expect(emitted[1]?.name).toBe("receipt_issued");
    expect(emitted.map((e) => e.payload?.seq)).toEqual([1, 3]);
    await ledger.close();
  });

  it("does not emit on append links", async () => {
    const emitted: unknown[] = [];
    const ledger = await ReceiptLedger.openMemory(
      { subject_id: SESSION },
      {
        emit: (envelope) => {
          emitted.push(envelope);
        }
      }
    );
    emitted.length = 0;
    await ledger.append({
      subject_kind: "reasoning",
      subject_id: "evt_reasoning"
    });
    expect(emitted).toHaveLength(0);
    await ledger.close();
  });

  it("omits sig on written records", async () => {
    const ledger = await ReceiptLedger.openMemory({ subject_id: SESSION });
    const genesisHead = ledger.head();
    expect(genesisHead.seq).toBe(1);
    const rec = await ledger.append({
      subject_kind: "tool_call",
      subject_id: "evt_1"
    });
    const keys = Object.keys(rec as ReceiptRecord);
    expect(keys).not.toContain("sig");
    await ledger.close();
  });

  it("throws VRC2002 for memory ledgers in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        ReceiptLedger.openMemory({ subject_id: SESSION })
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof VisReceiptError && err.code === "VRC2002";
      });
    } finally {
      if (prev === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prev;
      }
    }
  });
});
