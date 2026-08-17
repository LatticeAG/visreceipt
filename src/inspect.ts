import { loadVrs, type VrsEvent } from "./vrs.js";
import type { InspectResult, ReceiptRecord, SessionEventLite } from "./types.js";

export interface InspectOpts {
  vrsPath?: string;
}

function asSeq(idOrSeq: string | number): number | undefined {
  if (typeof idOrSeq === "number") {
    return Number.isInteger(idOrSeq) && idOrSeq >= 1 ? idOrSeq : undefined;
  }
  if (/^[0-9]+$/.test(idOrSeq)) {
    const seq = Number(idOrSeq);
    return Number.isInteger(seq) && seq >= 1 ? seq : undefined;
  }
  return undefined;
}

function toLite(event: VrsEvent): SessionEventLite {
  const lite: SessionEventLite = {
    eventId: event.eventId,
    index: event.index,
    timestamp: event.timestamp,
    type: String(event.type)
  };
  if (typeof event.name === "string") {
    lite.name = event.name;
  }
  if (event.arguments) {
    lite.arguments = event.arguments;
  }
  if (event.result !== undefined) {
    lite.result = event.result;
  }
  if (event.content !== undefined) {
    lite.content = event.content;
  }
  if (typeof event.error === "string") {
    lite.error = event.error;
  }
  if (typeof event.method === "string") {
    lite.method = event.method;
  }
  if (event.metadata) {
    lite.metadata = event.metadata;
  }
  return lite;
}

export async function inspectLedger(
  records: ReceiptRecord[],
  idOrSeq: string | number,
  opts?: InspectOpts
): Promise<InspectResult> {
  const seq = asSeq(idOrSeq);
  const record =
    seq !== undefined
      ? records.find((item) => item.seq === seq)
      : records.find((item) => item.receipt_id === idOrSeq);
  if (!record) {
    throw new Error(`record not found: ${String(idOrSeq)}`);
  }
  const seqs = new Set(records.map((item) => item.seq));
  const result: InspectResult = {
    record,
    prev_seq: seqs.has(record.seq - 1) ? record.seq - 1 : null,
    next_seq: seqs.has(record.seq + 1) ? record.seq + 1 : null
  };
  if (record.payload !== undefined) {
    result.payload_body = record.payload;
  }
  if (opts?.vrsPath) {
    const session = await loadVrs(opts.vrsPath);
    const event = session.events.find((item) => item.eventId === record.subject_id);
    if (event) {
      result.vrs_event = toLite(event);
    }
  }
  return result;
}
