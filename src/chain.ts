import { createHash } from "node:crypto";
import { canonicalize, crockford32, sha256Hex } from "./jcs.js";
import { isHex64 } from "./ids.js";
import { assertKindFreeze, LEDGER_VERSION } from "./types.js";
import type { Commitment, JsonValue, ReceiptRecord, RecordKind, VerifyReason, VerifyResult } from "./types.js";

export const GENESIS_DOMAIN = "visreceipt/v1:";
const NEXT_PATH = /^[\w.-]+\.vrc(?:\.\d+)?$/;
const KEYS = ["v", "kind", "ledger_id", "seq", "ts", "nonce", "prev_hash", "freeze_point", "subject_kind", "subject_id", "payload_sha256"] as const;

export { isHex64 };
export function genesisHash(ledgerId: string): string { return sha256Hex(GENESIS_DOMAIN + ledgerId); }
export function hashCommitment(c: Commitment): string { return sha256Hex(canonicalize(c as unknown as JsonValue)); }
export function deriveReceiptId(ledgerId: string, seq: number, payloadSha256: string): string {
  return `rcp_${crockford32(createHash("sha256").update(`${ledgerId}|${seq}|${payloadSha256}`).digest()).slice(0, 26)}`;
}
export function commitmentOf(record: Pick<Commitment, typeof KEYS[number]>): Commitment {
  const c = {} as Commitment;
  for (const k of KEYS) {
    if (record[k] === undefined) throw Object.assign(new Error("incomplete_commitment"), { reason: "incomplete_commitment" as const });
    (c as unknown as Record<string, unknown>)[k] = record[k];
  }
  return c;
}
export function chainRecord(input: Omit<ReceiptRecord, "hash" | "receipt_id">): ReceiptRecord {
  const c = commitmentOf(input);
  return { ...input, hash: hashCommitment(c), receipt_id: deriveReceiptId(input.ledger_id, input.seq, input.payload_sha256) };
}
export interface VerifyOpts { expectedHead?: string; expectedGenesis?: string; startPrevHash?: string; }
function out(ok: boolean, n: number, through: number, extra: Partial<VerifyResult> & { broken_at: VerifyResult["broken_at"] }): VerifyResult {
  return { ok, record_count: n, verified_through_seq: through, files_walked: extra.files_walked ?? [], ...extra };
}
function at(seq: number, line: number, kind: RecordKind | "unknown", reason: VerifyReason, expected?: string, actual?: string) {
  return { seq, line, kind, reason, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) };
}
export function verifyChain(records: ReceiptRecord[], opts?: VerifyOpts): VerifyResult {
  const n = records.length;
  if (n === 0) return out(false, 0, 0, { broken_at: at(0, 0, "unknown", "empty_ledger") });
  const skip = opts?.startPrevHash !== undefined;
  let lastHash = "";
  let lastSeq = 0;
  let ledgerId = "";
  let fileIndex = 1;
  for (let i = 0; i < n; i++) {
    const r = records[i]!;
    const line = i + 1;
    const kind = (r.kind ?? "unknown") as RecordKind | "unknown";
    const seq = typeof r.seq === "number" ? r.seq : lastSeq + 1;
    const miss = (reason: VerifyReason, expected?: string, actual?: string): VerifyResult =>
      out(false, n, lastSeq, { ledger_id: ledgerId || r.ledger_id, broken_at: at(seq, line, kind, reason, expected, actual) });
    let c: Commitment;
    try { c = commitmentOf(r); } catch { return miss("incomplete_commitment"); }
    if (i === 0) {
      ledgerId = r.ledger_id;
      fileIndex = r.file_index ?? 1;
      if (!skip) {
        if (r.kind !== "genesis" || r.seq !== 1 || r.freeze_point !== "session_start") return miss("bad_genesis");
        const gen = genesisHash(r.ledger_id);
        if (r.prev_hash !== gen || (opts?.expectedGenesis !== undefined && opts.expectedGenesis !== gen)) {
          return miss("genesis_mismatch", gen, r.prev_hash);
        }
      } else if (r.prev_hash !== opts.startPrevHash) {
        return miss("prev_mismatch", opts.startPrevHash, r.prev_hash);
      }
    } else {
      if (r.v !== LEDGER_VERSION || r.ledger_id !== ledgerId) return miss("ledger_id_mismatch", ledgerId, r.ledger_id);
      if (r.seq !== lastSeq + 1) return miss("seq_gap", String(lastSeq + 1), String(r.seq));
      if (r.prev_hash !== lastHash) return miss("prev_mismatch", lastHash, r.prev_hash);
      if (r.kind === "continuation") {
        const expectFi = fileIndex + 1;
        if ((r.file_index ?? 0) !== expectFi) return miss("seq_gap", String(expectFi), String(r.file_index));
        fileIndex = r.file_index ?? expectFi;
      }
    }
    if (!isHex64(r.prev_hash) || !isHex64(r.hash) || !isHex64(r.payload_sha256)) return miss("bad_hash_encoding");
    if (!assertKindFreeze(r.kind, r.freeze_point)) return miss("kind_freeze_mismatch");
    const h = hashCommitment(c);
    if (h !== r.hash) return miss("hash_mismatch", h, r.hash);
    const id = deriveReceiptId(r.ledger_id, r.seq, r.payload_sha256);
    if (id !== r.receipt_id) return miss("id_mismatch", id, r.receipt_id);
    if (r.payload !== undefined) {
      const ph = sha256Hex(canonicalize(r.payload));
      if (ph !== r.payload_sha256) return miss("payload_mismatch", r.payload_sha256, ph);
    }
    if (r.kind === "rotation") {
      const p = r.next_path ?? "";
      if (p.includes("/") || p.includes("..") || !NEXT_PATH.test(p)) return miss("path_escape", undefined, p);
      if (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)) {
        const np = (r.payload as { next_path?: unknown }).next_path;
        if (np !== undefined && np !== p) return miss("payload_mismatch", p, String(np));
      }
    }
    lastHash = r.hash;
    lastSeq = r.seq;
  }
  if (opts?.expectedHead !== undefined && lastHash !== opts.expectedHead) {
    return out(false, n, lastSeq, {
      ledger_id: ledgerId, chain_head: lastHash, seq: lastSeq,
      broken_at: at(lastSeq, n, records[n - 1]!.kind, "head_mismatch", opts.expectedHead, lastHash)
    });
  }
  return out(true, n, lastSeq, { ledger_id: ledgerId, chain_head: lastHash, seq: lastSeq, broken_at: null });
}
