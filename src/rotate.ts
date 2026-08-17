import { basename, dirname, join, resolve } from "node:path";

import { VisReceiptError } from "./errors.js";
import { parseLedgerText } from "./parse.js";
import { readLedgerFile } from "./repair.js";
import type { ReceiptRecord, VerifyResult } from "./types.js";

export const DEFAULT_MAX_LEDGER_BYTES = 67108864;
export const DEFAULT_MAX_RECORDS = 100000;
export const MAX_ROTATION_FILES = 32;
export const NEXT_PATH_RE = /^[\w.-]+\.vrc(?:\.\d+)?$/;

export function shouldRotate(input: {
  records: number;
  bytes: number;
  nextLineBytes: number;
  max_records?: number;
  max_ledger_bytes?: number;
}): boolean {
  const maxRecords = input.max_records ?? DEFAULT_MAX_RECORDS;
  const maxBytes = input.max_ledger_bytes ?? DEFAULT_MAX_LEDGER_BYTES;
  if (input.records >= maxRecords) {
    return true;
  }
  return input.bytes + input.nextLineBytes > maxBytes;
}

export function nextRotationPath(currentPath: string): string {
  const base = basename(currentPath);
  const numbered = /^(.*\.vrc)\.(\d+)$/.exec(base);
  if (numbered) {
    return `${numbered[1]}.${Number(numbered[2]) + 1}`;
  }
  return `${base}.2`;
}

export interface RotationRun {
  files: string[];
  records: ReceiptRecord[];
  fail?: VerifyResult;
}

function failRun(
  files: string[],
  records: ReceiptRecord[],
  result: VerifyResult
): RotationRun {
  return {
    files,
    records,
    fail: { ...result, files_walked: files }
  };
}

export async function collectRotationRun(startPath: string): Promise<RotationRun> {
  const files: string[] = [];
  const records: ReceiptRecord[] = [];
  const seen = new Set<string>();
  let current = startPath;

  for (;;) {
    if (files.length >= MAX_ROTATION_FILES) {
      throw new VisReceiptError("VRC1017", { detail: "rotation_runaway" });
    }
    const resolved = resolve(current);
    if (seen.has(resolved)) {
      const last = records[records.length - 1];
      return failRun(files, records, {
        ok: false,
        ledger_id: last?.ledger_id,
        record_count: records.length,
        verified_through_seq: last?.seq ?? 0,
        files_walked: files,
        broken_at: {
          seq: last?.seq ?? 0,
          line: records.length,
          kind: last?.kind ?? "rotation",
          reason: "path_escape",
          actual: current
        }
      });
    }
    seen.add(resolved);

    let text: string;
    try {
      text = await readLedgerFile(current);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (files.length === 0) {
        throw error;
      }
      if (error instanceof VisReceiptError && error.code === "VRC1003") {
        const last = records[records.length - 1];
        return failRun(files, records, {
          ok: false,
          ledger_id: last?.ledger_id,
          record_count: records.length,
          verified_through_seq: last?.seq ?? 0,
          files_walked: files,
          broken_at: {
            seq: last?.seq ?? 1,
            line: 1,
            kind: last?.kind ?? "unknown",
            reason: "not_canonical"
          }
        });
      }
      if (err.code === "ENOENT") {
        const last = records[records.length - 1];
        return failRun(files, records, {
          ok: false,
          ledger_id: last?.ledger_id,
          record_count: records.length,
          verified_through_seq: last?.seq ?? 0,
          files_walked: files,
          broken_at: {
            seq: last?.seq ?? 0,
            line: records.length,
            kind: last?.kind ?? "rotation",
            reason: "path_escape",
            actual: current
          }
        });
      }
      throw error;
    }

    files.push(current);
    const parsed = parseLedgerText(text);
    if ("result" in parsed) {
      const last = records[records.length - 1];
      return failRun(files, records, {
        ...parsed.result,
        ledger_id: parsed.result.ledger_id ?? last?.ledger_id,
        record_count: records.length + parsed.result.record_count,
        verified_through_seq: parsed.result.verified_through_seq || last?.seq || 0
      });
    }

    records.push(...parsed.records);
    const last = parsed.records[parsed.records.length - 1];
    if (last?.kind !== "rotation") {
      return { files, records };
    }
    const next = last.next_path ?? "";
    if (next.includes("/") || next.includes("..") || !NEXT_PATH_RE.test(next)) {
      return failRun(files, records, {
        ok: false,
        ledger_id: last.ledger_id,
        record_count: records.length,
        verified_through_seq: last.seq,
        files_walked: files,
        broken_at: {
          seq: last.seq,
          line: records.length,
          kind: "rotation",
          reason: "path_escape",
          actual: next
        }
      });
    }
    current = join(dirname(current), next);
  }
}
