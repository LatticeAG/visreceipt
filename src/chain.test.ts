import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chainRecord,
  commitmentOf,
  deriveReceiptId,
  genesisHash,
  hashCommitment,
  verifyChain
} from "./chain.js";
import { canonicalize, sha256Hex } from "./jcs.js";
import type { Commitment, JsonValue, ReceiptRecord } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const chainDir = join(here, "..", "conformance", "chain");

function loadVector(name: string): {
  commitment: Commitment;
  jcs: string;
  hash: string;
  receipt_id?: string;
  genesis_prev?: string;
} {
  return JSON.parse(readFileSync(join(chainDir, name), "utf8")) as {
    commitment: Commitment;
    jcs: string;
    hash: string;
    receipt_id?: string;
    genesis_prev?: string;
  };
}

function recordFromCommitment(c: Commitment): ReceiptRecord {
  return chainRecord({ ...c });
}

describe("§6.4 genesis vector", () => {
  const genesis = loadVector("genesis.json");

  it("genesisHash matches the frozen domain digest", () => {
    expect(genesisHash(genesis.commitment.ledger_id)).toBe(
      "c07b4a4613d47b21a81f4faf2aa50cfc5cbf379a630aba325094cf04f6b836fb"
    );
    expect(genesis.genesis_prev).toBe(genesisHash(genesis.commitment.ledger_id));
  });

  it("JCS, hash, and receipt_id match the frozen strings", () => {
    const jcs = canonicalize(genesis.commitment as unknown as JsonValue);
    expect(jcs).toBe(genesis.jcs);
    expect(hashCommitment(genesis.commitment)).toBe(
      "1a8024fe4e29c6ac6083d99472ba23afeead9f649726b51028f866bf3fa3b73d"
    );
    expect(deriveReceiptId(
      genesis.commitment.ledger_id,
      genesis.commitment.seq,
      genesis.commitment.payload_sha256
    )).toBe("rcp_DJ4SKTAF7MM9A0KNAX80JXVAQW");
    expect(genesis.receipt_id).toBe("rcp_DJ4SKTAF7MM9A0KNAX80JXVAQW");
  });

  it("a one-character JCS edit does not reproduce the frozen hash", () => {
    const jcs = canonicalize(genesis.commitment as unknown as JsonValue);
    const edited = jcs.replace("session_start", "session_starx");
    expect(edited).not.toBe(jcs);
    expect(sha256Hex(edited)).not.toBe(genesis.hash);
  });
});

describe("§6.5 link and seal vectors", () => {
  it("link hashes to the frozen digest", () => {
    const link = loadVector("link.json");
    expect(canonicalize(link.commitment as unknown as JsonValue)).toBe(link.jcs);
    expect(hashCommitment(link.commitment)).toBe(
      "3f8a45fb5b930a61c797633140c2db33a406ef51e1e60398fbea93ad5f5a70c0"
    );
  });

  it("seal hashes to the frozen digest", () => {
    const seal = loadVector("seal.json");
    expect(canonicalize(seal.commitment as unknown as JsonValue)).toBe(seal.jcs);
    expect(hashCommitment(seal.commitment)).toBe(
      "9d117e3b3bfc3ae7c6d883049898982b016c9737398d68d12d3ca1cf397a599f"
    );
  });
});

describe("verifyChain", () => {
  const genesis = loadVector("genesis.json");
  const link = loadVector("link.json");
  const seal = loadVector("seal.json");
  const records: ReceiptRecord[] = [
    recordFromCommitment(genesis.commitment),
    recordFromCommitment(link.commitment),
    recordFromCommitment(seal.commitment)
  ];

  it("accepts the 3-record worked example", () => {
    const result = verifyChain(records);
    expect(result.ok).toBe(true);
    expect(result.seq).toBe(3);
    expect(result.chain_head).toBe(
      "9d117e3b3bfc3ae7c6d883049898982b016c9737398d68d12d3ca1cf397a599f"
    );
    expect(result.broken_at).toBeNull();
    expect(result.verified_through_seq).toBe(3);
    expect(result.record_count).toBe(3);
    expect(records[0]?.receipt_id).toBe("rcp_DJ4SKTAF7MM9A0KNAX80JXVAQW");
  });

  it("fails empty_ledger at line 0", () => {
    const result = verifyChain([]);
    expect(result.ok).toBe(false);
    expect(result.broken_at?.reason).toBe("empty_ledger");
    expect(result.broken_at?.line).toBe(0);
    expect(result.verified_through_seq).toBe(0);
  });

  it("stops at the first broken link and names seq, line, reason", () => {
    const mutated = records.map((r) => ({ ...r }));
    mutated[1] = { ...mutated[1]!, payload_sha256: mutated[1]!.payload_sha256.replace(/0/, "1") };
    const result = verifyChain(mutated);
    expect(result.ok).toBe(false);
    expect(result.broken_at?.seq).toBe(2);
    expect(result.broken_at?.line).toBe(2);
    expect(result.broken_at?.reason).toBe("hash_mismatch");
    expect(result.verified_through_seq).toBe(1);
  });

  it("commitmentOf picks exactly the eleven keys", () => {
    const c = commitmentOf(records[0]!);
    expect(Object.keys(c).sort()).toEqual([
      "freeze_point",
      "kind",
      "ledger_id",
      "nonce",
      "payload_sha256",
      "prev_hash",
      "seq",
      "subject_id",
      "subject_kind",
      "ts",
      "v"
    ].sort());
  });
});
