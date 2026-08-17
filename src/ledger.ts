import { open, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { chainRecord, genesisHash, verifyChain } from "./chain.js";
import { exportRange as buildExport, type ExportRangeOpts } from "./export.js";
import { VisReceiptError } from "./errors.js";
import { inspectLedger, type InspectOpts } from "./inspect.js";
import { createLedgerId, createNonce, ledgerIdFromSessionId } from "./ids.js";
import { canonicalize, sha256Hex } from "./jcs.js";
import { parseLedgerText } from "./parse.js";
import { readLedgerFile, repairTail } from "./repair.js";
import {
  DEFAULT_MAX_LEDGER_BYTES,
  DEFAULT_MAX_RECORDS,
  NEXT_PATH_RE,
  collectRotationRun,
  nextRotationPath,
  shouldRotate
} from "./rotate.js";
import { isTimeRegression, nowIso } from "./time.js";
import { isVrsPointer, LEDGER_VERSION } from "./types.js";
import type {
  FreezePoint,
  GenesisInput,
  InspectResult,
  JsonObject,
  JsonValue,
  OpenOptions,
  ReceiptRecord,
  RecordKind,
  SubchainExport,
  SubjectInput,
  SubjectKind,
  VerifyResult
} from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POINTER_MAX = 4096;
const STALE_LOCK_MS = 60_000;
const SEAL_FREEZE: ReadonlySet<string> = new Set([
  "belief_batch",
  "tool_result",
  "verdict",
  "session_end",
  "approval_granted",
  "effect_closed"
]);

export interface VerifyFileOpts {
  expectedHead?: string;
  strictTime?: boolean;
}

type FsyncMode = "always" | "interval" | "never";

function looksLikeSession(subjectId: string): boolean {
  if (subjectId.startsWith("ses_")) {
    return true;
  }
  if (UUID_RE.test(subjectId)) {
    return true;
  }
  return subjectId.startsWith("led_") && UUID_RE.test(subjectId.slice(4));
}

function resolveLedgerId(genesis: GenesisInput): string {
  if (genesis.ledger_id) {
    return genesis.ledger_id;
  }
  if (looksLikeSession(genesis.subject_id)) {
    const asSession = genesis.subject_id.startsWith("led_")
      ? `ses_${genesis.subject_id.slice(4)}`
      : genesis.subject_id;
    return ledgerIdFromSessionId(asSession);
  }
  return createLedgerId();
}

function genesisPointer(genesis: GenesisInput): JsonObject {
  const payload: JsonObject = {
    agent_type: genesis.agent_type ?? "unknown",
    session_id: genesis.subject_id,
    session_name: genesis.session_name ?? "unnamed-session",
    started_at: genesis.started_at ?? nowIso()
  };
  if (genesis.source_path !== undefined) {
    payload.source_path = genesis.source_path;
  }
  return payload;
}

function assertPointer(payload: JsonValue): void {
  const jcs = canonicalize(payload);
  if (jcs.length > POINTER_MAX) {
    throw new VisReceiptError("VRC2014", { detail: "pointer_too_large" });
  }
}

function payloadDigest(subject: SubjectInput): string {
  if (typeof subject.payload_sha256 === "string") {
    return subject.payload_sha256;
  }
  if (subject.raw_payload_bytes) {
    return sha256Hex(subject.raw_payload_bytes);
  }
  return sha256Hex(canonicalize(subject.payload ?? {}));
}

function recordsForChain(records: ReceiptRecord[]): ReceiptRecord[] {
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
    const next = { ...record };
    delete next.payload;
    return next;
  });
}

interface LockState {
  handle: FileHandle;
  path: string;
}

async function acquireLock(ledgerPath: string): Promise<LockState> {
  const lockPath = `${ledgerPath}.lock`;
  for (let i = 0; i < 4; i++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return { handle, path: lockPath };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      throw new Error(`ledger locked: ${lockPath}`);
    }
  }
  throw new Error(`ledger locked: ${lockPath}`);
}

async function releaseLock(lock: LockState | undefined): Promise<void> {
  if (!lock) {
    return;
  }
  try {
    await lock.handle.close();
  } catch {
    // already closed
  }
  try {
    await unlink(lock.path);
  } catch {
    // missing is fine
  }
}

function failOpen(result: VerifyResult): never {
  const reason = result.broken_at?.reason;
  const opts = {
    seq: result.broken_at?.seq,
    line: result.broken_at?.line,
    expected: result.broken_at?.expected,
    actual: result.broken_at?.actual
  };
  if (reason === "truncated_tail") {
    throw new VisReceiptError("VRC1004", opts);
  }
  if (reason === "not_canonical") {
    throw new VisReceiptError("VRC1003", opts);
  }
  if (reason === "path_escape") {
    throw new VisReceiptError("VRC1006", opts);
  }
  if (reason === "empty_ledger") {
    throw new VisReceiptError("VRC1001", opts);
  }
  throw new VisReceiptError("VRC1004", opts);
}

export async function verifyFile(path: string, opts?: VerifyFileOpts): Promise<VerifyResult> {
  const run = await collectRotationRun(path);
  if (run.fail) {
    return run.fail;
  }
  const result = verifyChain(recordsForChain(run.records), { expectedHead: opts?.expectedHead });
  result.files_walked = run.files;
  if (result.ok && opts?.strictTime) {
    for (let i = 1; i < run.records.length; i++) {
      const prev = run.records[i - 1]!;
      const cur = run.records[i]!;
      if (isTimeRegression(prev.ts, cur.ts)) {
        return {
          ...result,
          ok: false,
          verified_through_seq: prev.seq,
          files_walked: run.files,
          broken_at: {
            seq: cur.seq,
            line: i + 1,
            kind: cur.kind,
            reason: "time_regression",
            expected: prev.ts,
            actual: cur.ts
          }
        };
      }
    }
  }
  return result;
}

export async function repairLedgerFile(
  path: string
): Promise<{ truncated: boolean; last_seq: number }> {
  const text = await readLedgerFile(path);
  const repaired = repairTail(text);
  if (repaired.truncated) {
    await writeFile(path, repaired.text, { encoding: "utf8", mode: 0o600 });
  }
  return { truncated: repaired.truncated, last_seq: repaired.last_seq };
}

interface PersistInput {
  kind: RecordKind;
  freeze_point: FreezePoint;
  subject_kind: SubjectKind;
  subject_id: string;
  payload?: JsonValue;
  omitPayload?: boolean;
  payload_sha256?: string;
  next_path?: string;
  file_index?: number;
  effect_id?: string;
  seal_hash?: string;
  anchor_seq?: number;
  forceSync: boolean;
  emit: boolean;
}

export class ReceiptLedger {
  readonly path: string;
  readonly ledger_id: string;
  private readonly memory: boolean;
  private readonly payloadMode: "commitments" | "embedded";
  private readonly fsyncMode: FsyncMode;
  private readonly fsyncIntervalMs: number;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly emitFn?: (envelope: unknown) => void | Promise<void>;
  private currentPath: string;
  private records: ReceiptRecord[] = [];
  private fh: FileHandle | undefined;
  private lock: LockState | undefined;
  private lastHash = "";
  private lastSeq = 0;
  private lastReceiptId = "";
  private fileIndex = 1;
  private fileBytes = 0;
  private fileRecords = 0;
  private closed = false;
  private pendingSync = false;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSyncAt = 0;

  private constructor(path: string, ledgerId: string, memory: boolean, opts?: OpenOptions) {
    this.path = path;
    this.ledger_id = ledgerId;
    this.memory = memory;
    this.currentPath = path;
    this.payloadMode = opts?.payload_mode ?? "commitments";
    this.fsyncMode = memory ? "never" : (opts?.fsync ?? "always");
    this.fsyncIntervalMs = opts?.fsync_interval_ms ?? 200;
    this.maxBytes = opts?.max_ledger_bytes ?? DEFAULT_MAX_LEDGER_BYTES;
    this.maxRecords = opts?.max_records ?? DEFAULT_MAX_RECORDS;
    this.emitFn = opts?.emit;
  }

  static async create(
    path: string,
    genesis: GenesisInput,
    opts?: OpenOptions
  ): Promise<ReceiptLedger> {
    const ledgerId = resolveLedgerId(genesis);
    const ledger = new ReceiptLedger(path, ledgerId, false, opts);
    await mkdir(dirname(path), { recursive: true });
    ledger.lock = await acquireLock(path);
    try {
      ledger.fh = await open(path, "ax", 0o600);
    } catch (error) {
      await ledger.close();
      throw error;
    }
    ledger.lastHash = genesisHash(ledgerId);
    await ledger.writeGenesis(genesis);
    return ledger;
  }

  static async open(path: string, opts?: OpenOptions): Promise<ReceiptLedger> {
    const run = await collectRotationRun(path);
    if (run.fail) {
      failOpen(run.fail);
    }
    if (run.records.length === 0) {
      throw new VisReceiptError("VRC1001");
    }
    const last = run.records[run.records.length - 1]!;
    const ledger = new ReceiptLedger(path, last.ledger_id, false, opts);
    ledger.records = run.records;
    ledger.currentPath = run.files[run.files.length - 1]!;
    ledger.lastHash = last.hash;
    ledger.lastSeq = last.seq;
    ledger.lastReceiptId = last.receipt_id;
    const currentText = await readLedgerFile(ledger.currentPath);
    const currentParsed = parseLedgerText(currentText);
    if ("result" in currentParsed) {
      failOpen(currentParsed.result);
    }
    ledger.fileRecords = currentParsed.records.length;
    ledger.fileBytes = Buffer.byteLength(currentText, "utf8");
    for (const rec of currentParsed.records) {
      if (rec.file_index !== undefined) {
        ledger.fileIndex = rec.file_index;
      }
    }
    ledger.lock = await acquireLock(path);
    try {
      ledger.fh = await open(ledger.currentPath, "a", 0o600);
    } catch (error) {
      await ledger.close();
      throw error;
    }
    return ledger;
  }

  static async openMemory(genesis: GenesisInput, opts?: OpenOptions): Promise<ReceiptLedger> {
    if (process.env.NODE_ENV === "production") {
      throw new VisReceiptError("VRC2002");
    }
    const ledgerId = resolveLedgerId(genesis);
    const ledger = new ReceiptLedger(":memory:", ledgerId, true, opts);
    ledger.lastHash = genesisHash(ledgerId);
    await ledger.writeGenesis(genesis);
    return ledger;
  }

  async append(subject: SubjectInput): Promise<ReceiptRecord> {
    await this.maybeRotate(subject);
    const sha = payloadDigest(subject);
    const embed =
      this.payloadMode === "embedded" &&
      subject.payload !== undefined &&
      subject.raw_payload_bytes === undefined;
    return this.persist({
      kind: "link",
      freeze_point: "event",
      subject_kind: subject.subject_kind,
      subject_id: subject.subject_id,
      payload: embed ? subject.payload : undefined,
      omitPayload: !embed,
      payload_sha256: sha,
      forceSync: this.fsyncMode === "always",
      emit: false
    });
  }

  async seal(
    freezePoint: Exclude<FreezePoint, "event" | "rotation" | "continuation">,
    subject: SubjectInput
  ): Promise<ReceiptRecord> {
    if (freezePoint === "session_start" || !SEAL_FREEZE.has(freezePoint)) {
      throw new Error("session_start is genesis-only");
    }
    await this.maybeRotate(subject);
    const sha = payloadDigest(subject);
    const omitPayload =
      subject.payload === undefined &&
      (subject.raw_payload_bytes !== undefined || subject.payload_sha256 !== undefined);
    const payload = omitPayload ? undefined : (subject.payload ?? {});
    if (payload !== undefined && this.payloadMode !== "embedded") {
      assertPointer(payload);
    }
    return this.persist({
      kind: "seal",
      freeze_point: freezePoint,
      subject_kind: subject.subject_kind,
      subject_id: subject.subject_id,
      payload,
      omitPayload,
      payload_sha256: sha,
      effect_id: subject.effect_id,
      seal_hash: subject.seal_hash,
      anchor_seq: subject.anchor_seq,
      forceSync: true,
      emit: true
    });
  }

  async verify(opts?: { expectedHead?: string }): Promise<VerifyResult> {
    if (this.memory) {
      const result = verifyChain(this.records, opts);
      result.files_walked = [this.path];
      return result;
    }
    return verifyFile(this.path, opts);
  }

  async exportRange(
    fromSeq: number,
    toSeq: number,
    opts?: { embedPayload?: boolean; vrsPath?: string }
  ): Promise<SubchainExport> {
    const loaded = await this.loadRecords();
    const buildOpts: ExportRangeOpts = {
      embedPayload: opts?.embedPayload,
      vrsPath: opts?.vrsPath,
      files: loaded.files
    };
    return buildExport(loaded.records, fromSeq, toSeq, buildOpts);
  }

  async inspect(idOrSeq: string | number, opts?: InspectOpts): Promise<InspectResult> {
    const loaded = await this.loadRecords();
    return inspectLedger(loaded.records, idOrSeq, opts);
  }

  head(): { seq: number; hash: string; receipt_id: string } {
    if (this.lastSeq === 0) {
      throw new Error("empty ledger");
    }
    return { seq: this.lastSeq, hash: this.lastHash, receipt_id: this.lastReceiptId };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.pendingSync && this.fh) {
      try {
        await this.fh.datasync();
      } catch {
        // closing anyway
      }
      this.pendingSync = false;
    }
    if (this.fh) {
      try {
        await this.fh.close();
      } catch {
        // already closed
      }
      this.fh = undefined;
    }
    await releaseLock(this.lock);
    this.lock = undefined;
  }

  private async loadRecords(): Promise<{ records: ReceiptRecord[]; files: string[] }> {
    if (this.memory) {
      return { records: this.records, files: [this.path] };
    }
    const run = await collectRotationRun(this.path);
    if (run.fail) {
      failOpen(run.fail);
    }
    return { records: run.records, files: run.files };
  }

  private async writeGenesis(genesis: GenesisInput): Promise<ReceiptRecord> {
    const payload = genesisPointer(genesis);
    assertPointer(payload);
    this.fileIndex = 1;
    return this.persist({
      kind: "genesis",
      freeze_point: "session_start",
      subject_kind: "session",
      subject_id: genesis.subject_id,
      payload,
      file_index: 1,
      forceSync: true,
      emit: true
    });
  }

  private async maybeRotate(subject: SubjectInput): Promise<void> {
    if (this.memory) {
      return;
    }
    const sha = payloadDigest(subject);
    const tentative = chainRecord({
      v: LEDGER_VERSION,
      kind: "link",
      ledger_id: this.ledger_id,
      seq: this.lastSeq + 1,
      ts: nowIso(),
      nonce: "00".repeat(16),
      prev_hash: this.lastHash,
      freeze_point: "event",
      subject_kind: subject.subject_kind,
      subject_id: subject.subject_id,
      payload_sha256: sha
    });
    const nextLineBytes = Buffer.byteLength(
      `${canonicalize(tentative as unknown as JsonValue)}\n`,
      "utf8"
    );
    if (
      !shouldRotate({
        records: this.fileRecords,
        bytes: this.fileBytes,
        nextLineBytes,
        max_records: this.maxRecords,
        max_ledger_bytes: this.maxBytes
      })
    ) {
      return;
    }
    const reason = this.fileRecords >= this.maxRecords ? "max_records" : "max_ledger_bytes";
    await this.rotate(reason);
  }

  private async rotate(reason: "max_records" | "max_ledger_bytes"): Promise<void> {
    const nextPath = nextRotationPath(this.currentPath);
    if (!NEXT_PATH_RE.test(nextPath)) {
      throw new VisReceiptError("VRC1006", { detail: nextPath, actual: nextPath });
    }
    const payload: JsonObject = {
      reason,
      bytes: this.fileBytes,
      records: this.fileRecords,
      next_path: nextPath
    };
    assertPointer(payload);
    await this.persist({
      kind: "rotation",
      freeze_point: "rotation",
      subject_kind: "ledger",
      subject_id: this.ledger_id,
      payload,
      next_path: nextPath,
      forceSync: true,
      emit: false
    });
    if (this.fh) {
      await this.fh.close();
      this.fh = undefined;
    }
    const prevFile = basename(this.currentPath);
    const absNext = join(dirname(this.currentPath), nextPath);
    this.fh = await open(absNext, "a", 0o600);
    this.currentPath = absNext;
    this.fileBytes = 0;
    this.fileRecords = 0;
    this.fileIndex += 1;
    const contPayload: JsonObject = { prev_file: prevFile };
    assertPointer(contPayload);
    await this.persist({
      kind: "continuation",
      freeze_point: "continuation",
      subject_kind: "ledger",
      subject_id: this.ledger_id,
      payload: contPayload,
      file_index: this.fileIndex,
      forceSync: true,
      emit: false
    });
  }

  private async persist(input: PersistInput): Promise<ReceiptRecord> {
    if (this.closed) {
      throw new Error("ledger is closed");
    }
    const seq = this.lastSeq + 1;
    const payload_sha256 =
      input.payload_sha256 ?? sha256Hex(canonicalize(input.payload ?? {}));
    const draft: Omit<ReceiptRecord, "hash" | "receipt_id"> = {
      v: LEDGER_VERSION,
      kind: input.kind,
      ledger_id: this.ledger_id,
      seq,
      ts: nowIso(),
      nonce: createNonce(),
      prev_hash: this.lastHash,
      freeze_point: input.freeze_point,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      payload_sha256
    };
    if (!input.omitPayload && input.payload !== undefined) {
      draft.payload = input.payload;
    }
    if (input.next_path !== undefined) {
      draft.next_path = input.next_path;
    }
    if (input.file_index !== undefined) {
      draft.file_index = input.file_index;
    }
    if (input.effect_id !== undefined) {
      draft.effect_id = input.effect_id;
    }
    if (input.seal_hash !== undefined) {
      draft.seal_hash = input.seal_hash;
    }
    if (input.anchor_seq !== undefined) {
      draft.anchor_seq = input.anchor_seq;
    }
    const record = chainRecord(draft);
    const line = `${canonicalize(record as unknown as JsonValue)}\n`;
    if (!this.memory) {
      if (!this.fh) {
        throw new Error("ledger file handle missing");
      }
      const bytes = Buffer.from(line, "utf8");
      await this.fh.write(bytes);
      this.fileBytes += bytes.length;
      this.fileRecords += 1;
      await this.afterWrite(input.forceSync);
    }
    this.records.push(record);
    this.lastSeq = record.seq;
    this.lastHash = record.hash;
    this.lastReceiptId = record.receipt_id;
    if (input.emit) {
      await this.emitIssued(record);
    }
    return record;
  }

  private async afterWrite(forceSync: boolean): Promise<void> {
    if (this.memory || !this.fh) {
      return;
    }
    if (forceSync || this.fsyncMode === "always") {
      await this.fh.datasync();
      this.lastSyncAt = Date.now();
      this.pendingSync = false;
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = undefined;
      }
      return;
    }
    const due = Date.now() - this.lastSyncAt >= this.fsyncIntervalMs;
    if (due) {
      await this.fh.datasync();
      this.lastSyncAt = Date.now();
      this.pendingSync = false;
      return;
    }
    this.pendingSync = true;
    if (!this.syncTimer) {
      const wait = Math.max(1, this.fsyncIntervalMs - (Date.now() - this.lastSyncAt));
      this.syncTimer = setTimeout(() => {
        this.syncTimer = undefined;
        void this.flushInterval();
      }, wait);
      this.syncTimer.unref();
    }
  }

  private async flushInterval(): Promise<void> {
    if (!this.pendingSync || !this.fh || this.closed) {
      return;
    }
    await this.fh.datasync();
    this.lastSyncAt = Date.now();
    this.pendingSync = false;
  }

  private async emitIssued(record: ReceiptRecord): Promise<void> {
    if (!this.emitFn) {
      return;
    }
    const payloadObj =
      record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
        ? (record.payload as JsonObject)
        : undefined;
    const approval = record.freeze_point === "approval_granted";
    const requestFromPayload =
      approval && typeof payloadObj?.request_id === "string" ? payloadObj.request_id : undefined;
    const payload: Record<string, unknown> = {
      request_id: requestFromPayload ?? record.receipt_id,
      execution_id: record.effect_id ?? requestFromPayload ?? record.subject_id,
      tier: "agent_asserted",
      action:
        approval && typeof payloadObj?.action === "string"
          ? payloadObj.action
          : `${record.freeze_point}:${record.subject_kind}`,
      issued_at:
        approval && typeof payloadObj?.resolved_at === "string"
          ? payloadObj.resolved_at
          : record.ts,
      payload_sha256: record.payload_sha256,
      receipt_id: record.receipt_id,
      ledger_id: record.ledger_id,
      seq: record.seq,
      prev_hash: record.prev_hash,
      hash: record.hash,
      chain_head: record.hash,
      freeze_point: record.freeze_point,
      subject_kind: record.subject_kind,
      subject_id: record.subject_id,
      nonce: record.nonce
    };
    if (!this.memory) {
      payload.sidecar_path = this.path;
    }
    if (record.effect_id !== undefined) {
      payload.effect_id = record.effect_id;
    }
    if (record.seal_hash !== undefined) {
      payload.seal_hash = record.seal_hash;
    }
    if (record.anchor_seq !== undefined) {
      payload.anchor_seq = record.anchor_seq;
    }
    await this.emitFn({ name: "receipt_issued", payload });
  }
}

export type { GenesisInput, OpenOptions, SubjectInput };
