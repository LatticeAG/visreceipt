import { VisReceiptError } from "./errors.js";
import { canonicalize } from "./jcs.js";
import { verifyChain, type VerifyOpts } from "./chain.js";
import type { JsonValue, ReceiptRecord, RecordKind, VerifyResult } from "./types.js";

function failText(
  reason: "not_canonical" | "truncated_tail",
  seq: number,
  line: number,
  kind: RecordKind | "unknown",
  verifiedThrough: number,
  recordCount: number,
  ledgerId?: string
): VerifyResult {
  return {
    ok: false,
    ledger_id: ledgerId,
    record_count: recordCount,
    verified_through_seq: verifiedThrough,
    files_walked: [],
    broken_at: { seq, line, kind, reason }
  };
}

export function parseLedgerText(text: string): { records: ReceiptRecord[] } | { result: VerifyResult } {
  if (text.includes("\r")) {
    return { result: failText("not_canonical", 1, 1, "unknown", 0, 0) };
  }
  if (text.length === 0) {
    return { records: [] };
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const records: ReceiptRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const last = records[records.length - 1];
      return {
        result: failText(
          "truncated_tail",
          last?.seq ?? 0,
          lineNo,
          last?.kind ?? "unknown",
          last?.seq ?? 0,
          records.length,
          last?.ledger_id
        )
      };
    }
    const rec = parsed as Partial<ReceiptRecord>;
    try {
      if (canonicalize(parsed as JsonValue) !== line) {
        return {
          result: failText(
            "not_canonical",
            typeof rec.seq === "number" ? rec.seq : lineNo,
            lineNo,
            rec.kind ?? "unknown",
            records[records.length - 1]?.seq ?? 0,
            records.length,
            rec.ledger_id
          )
        };
      }
    } catch (error) {
      throw new VisReceiptError("VRC1003", {
        detail: error instanceof Error ? error.message : String(error),
        line: lineNo
      });
    }
    records.push(parsed as ReceiptRecord);
  }
  return { records };
}

export function verifyLedgerText(text: string, opts?: VerifyOpts): VerifyResult {
  const parsed = parseLedgerText(text);
  if ("result" in parsed) {
    return parsed.result;
  }
  return verifyChain(parsed.records, opts);
}
