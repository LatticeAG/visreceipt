import { VisReceiptError } from "./errors.js";
import { verifyChain, type VerifyOpts } from "./chain.js";
import { canonicalize, sha256Hex } from "./jcs.js";
import { nowIso } from "./time.js";
import { isVrsPointer } from "./types.js";
import { eventAsStored, loadVrs } from "./vrs.js";
import type { ReceiptRecord, SubchainExport, VerifyReason, VerifyResult } from "./types.js";

export const EXPORT_SCHEMA = "visreceipt/export/1.0" as const;
export const EXPORT_MAX_BYTES = 32 * 1024 * 1024;

export interface ExportRangeOpts {
  embedPayload?: boolean;
  vrsPath?: string;
  files?: string[];
  createdAt?: string;
}

export interface VerifyExportOpts {
  expectedHead?: string;
  expectedStartPrev?: string;
}

function miss(
  reason: VerifyReason,
  records: ReceiptRecord[],
  expected?: string,
  actual?: string
): VerifyResult {
  const last = records[records.length - 1];
  const n = records.length;
  return {
    ok: false,
    ledger_id: last?.ledger_id,
    chain_head: last?.hash,
    seq: last?.seq,
    record_count: n,
    verified_through_seq: last?.seq ?? 0,
    files_walked: [],
    broken_at: {
      seq: last?.seq ?? 0,
      line: n,
      kind: last?.kind ?? "unknown",
      reason,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual })
    }
  };
}

function copyRecord(record: ReceiptRecord): ReceiptRecord {
  return { ...record };
}

function commitmentsRecords(records: ReceiptRecord[]): ReceiptRecord[] {
  return records.map((record) => {
    if (record.payload === undefined) {
      return record;
    }
    let digest: string;
    try {
      digest = sha256Hex(canonicalize(record.payload));
    } catch {
      return record;
    }
    if (digest === record.payload_sha256) {
      return record;
    }
    if (!isVrsPointer(record.payload)) {
      return record;
    }
    const next = copyRecord(record);
    delete next.payload;
    return next;
  });
}

function assertRange(fromSeq: number, toSeq: number): void {
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) {
    throw new Error("export range requires from_seq >= 1 and to_seq >= from_seq");
  }
}

export async function exportRange(
  records: ReceiptRecord[],
  fromSeq: number,
  toSeq: number,
  opts?: ExportRangeOpts
): Promise<SubchainExport> {
  assertRange(fromSeq, toSeq);
  const bySeq = new Map<number, ReceiptRecord>();
  for (const record of records) {
    bySeq.set(record.seq, record);
  }
  if (!bySeq.has(fromSeq) || !bySeq.has(toSeq)) {
    throw new Error(`export range ${fromSeq}..${toSeq} is not present in the ledger`);
  }
  const selected: ReceiptRecord[] = [];
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    const record = bySeq.get(seq);
    if (!record) {
      throw new Error(`export range is missing seq ${seq}`);
    }
    selected.push(copyRecord(record));
  }
  const embed = Boolean(opts?.embedPayload);
  if (embed) {
    if (!opts?.vrsPath) {
      throw new Error("embed-payload requires a .vrs path");
    }
    const session = await loadVrs(opts.vrsPath);
    const events = new Map(session.events.map((event) => [event.eventId, event]));
    for (const record of selected) {
      const event = events.get(record.subject_id);
      if (event) {
        record.payload = eventAsStored(event);
      }
    }
  }
  const first = selected[0]!;
  const last = selected[selected.length - 1]!;
  const recordsOut = embed ? selected : commitmentsRecords(selected);
  const slice: SubchainExport = {
    $schema: EXPORT_SCHEMA,
    ledger_id: first.ledger_id,
    from_seq: fromSeq,
    to_seq: toSeq,
    start_prev_hash: first.prev_hash,
    end_hash: last.hash,
    record_count: recordsOut.length,
    payload_mode: embed ? "embedded" : "commitments",
    created_at: opts?.createdAt ?? nowIso(),
    files: opts?.files ? [...opts.files] : [],
    records: recordsOut
  };
  const bytes = Buffer.byteLength(JSON.stringify(slice), "utf8");
  if (bytes > EXPORT_MAX_BYTES) {
    throw new VisReceiptError("VRC2014", { detail: "export_too_large" });
  }
  return slice;
}

function asExport(value: unknown): SubchainExport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("export slice must be a JSON object");
  }
  const rec = value as Partial<SubchainExport>;
  if (rec.$schema !== EXPORT_SCHEMA) {
    throw new Error(`export slice $schema must be ${EXPORT_SCHEMA}`);
  }
  if (typeof rec.ledger_id !== "string" || rec.ledger_id.length === 0) {
    throw new Error("export slice is missing ledger_id");
  }
  if (typeof rec.from_seq !== "number" || typeof rec.to_seq !== "number") {
    throw new Error("export slice requires from_seq and to_seq");
  }
  if (!Array.isArray(rec.records)) {
    throw new Error("export slice requires records");
  }
  return rec as SubchainExport;
}

export function verifyExport(sliceInput: unknown, opts?: VerifyExportOpts): VerifyResult {
  const slice = asExport(sliceInput);
  const records = slice.records;
  const fromSeq = slice.from_seq;
  const toSeq = slice.to_seq;
  if (!Number.isInteger(fromSeq) || fromSeq < 1 || !Number.isInteger(toSeq) || toSeq < fromSeq) {
    throw new Error("export slice from_seq/to_seq is invalid");
  }
  const expectCount = toSeq - fromSeq + 1;
  if (records.length !== expectCount || slice.record_count !== expectCount) {
    return miss("seq_gap", records, String(expectCount), String(records.length));
  }
  if (records.length === 0) {
    return miss("empty_ledger", records);
  }
  const first = records[0]!;
  const last = records[records.length - 1]!;
  if (first.seq !== fromSeq || last.seq !== toSeq) {
    return miss("seq_gap", records, `${fromSeq}..${toSeq}`, `${first.seq}..${last.seq}`);
  }
  if (opts?.expectedStartPrev !== undefined && opts.expectedStartPrev !== slice.start_prev_hash) {
    return miss("prev_mismatch", records, opts.expectedStartPrev, slice.start_prev_hash);
  }
  const chainOpts: VerifyOpts = { expectedHead: slice.end_hash };
  if (fromSeq > 1) {
    chainOpts.startPrevHash = slice.start_prev_hash;
  }
  const result = verifyChain(commitmentsRecords(records), chainOpts);
  result.files_walked = Array.isArray(slice.files) ? slice.files : [];
  if (!result.ok) {
    return result;
  }
  if (opts?.expectedHead !== undefined && opts.expectedHead !== result.chain_head) {
    return {
      ...result,
      ok: false,
      broken_at: {
        seq: last.seq,
        line: records.length,
        kind: last.kind,
        reason: "head_mismatch",
        expected: opts.expectedHead,
        actual: result.chain_head
      }
    };
  }
  return result;
}
