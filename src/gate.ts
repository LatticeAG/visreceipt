import { VisReceiptError } from "./errors.js";
import type { ReceiptLedger } from "./ledger.js";
import type { FreezePoint, GateQuery, ReceiptRecord } from "./types.js";

export const DEFAULT_GATE_MAX_AGE_MS = 300000;
export const DEFAULT_GATE_FREEZE: FreezePoint = "belief_batch";

function isMatchingSeal(record: ReceiptRecord, query: GateQuery, freeze: FreezePoint): boolean {
  if (record.subject_id !== query.subject_id) {
    return false;
  }
  if (record.freeze_point !== freeze) {
    return false;
  }
  if (query.subject_kind !== undefined && record.subject_kind !== query.subject_kind) {
    return false;
  }
  if (record.kind === "seal") {
    return true;
  }
  return record.kind === "genesis" && freeze === "session_start";
}

export async function assertSealed(
  ledger: ReceiptLedger,
  query: GateQuery
): Promise<ReceiptRecord> {
  const verified = await ledger.verify();
  if (!verified.ok) {
    throw new VisReceiptError("VRC2004", {
      detail: verified.broken_at?.reason,
      seq: verified.broken_at?.seq,
      line: verified.broken_at?.line,
      expected: verified.broken_at?.expected,
      actual: verified.broken_at?.actual
    });
  }
  const freeze = query.freeze_point ?? DEFAULT_GATE_FREEZE;
  const head = ledger.head();
  const slice = await ledger.exportRange(1, head.seq);
  let match: ReceiptRecord | undefined;
  for (let i = slice.records.length - 1; i >= 0; i--) {
    const record = slice.records[i]!;
    if (isMatchingSeal(record, query, freeze)) {
      match = record;
      break;
    }
  }
  if (!match) {
    throw new VisReceiptError("VRC2001", {
      detail: `${freeze}:${query.subject_id}`
    });
  }
  const maxAge = query.max_age_ms ?? DEFAULT_GATE_MAX_AGE_MS;
  if (maxAge > 0) {
    const issued = Date.parse(match.ts);
    if (!Number.isNaN(issued) && Date.now() - issued > maxAge) {
      throw new VisReceiptError("VRC2003", {
        seq: match.seq,
        detail: match.receipt_id
      });
    }
  }
  return match;
}
