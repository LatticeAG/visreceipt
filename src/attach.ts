import { existsSync } from "node:fs";

import { admitSession, sessionEndPointer } from "./admit.js";
import { VisReceiptError } from "./errors.js";
import { ledgerIdFromSessionId } from "./ids.js";
import { ReceiptLedger } from "./ledger.js";
import { sidecarPath } from "./paths.js";
import { redactForEmbed } from "./redact.js";
import { collectRotationRun } from "./rotate.js";
import type { SessionData } from "./vrs.js";
import { eventAsStored } from "./vrs.js";
import type { JsonValue, OpenOptions, ReceiptRecord } from "./types.js";

const ATTACHED = Symbol.for("visreceipt.attached");
const poisonedLedgers = new Set<string>();

export interface AttachOptions {
  include_wrap_io?: boolean;
  payload_mode?: "commitments" | "embedded";
  fsync?: "always" | "interval";
  emit?: (envelope: unknown) => void | Promise<void>;
}

export interface SealFromSessionOptions extends AttachOptions {
  session_end?: boolean;
  source_path?: string;
}

export interface SealFromSessionResult {
  last: { seq: number; hash: string; receipt_id: string };
  created: boolean;
  appended: number;
}

export interface ReceiptRecorder {
  save(filePath: string): Promise<void>;
  getSession(): SessionData;
}

export { sidecarPath };

export function attachReceipts<T extends ReceiptRecorder>(
  recorder: T,
  opts?: AttachOptions
): T {
  const target = recorder as T & { [ATTACHED]?: boolean };
  if (target[ATTACHED]) {
    return recorder;
  }
  const orig = recorder.save.bind(recorder);
  recorder.save = async (filePath: string): Promise<void> => {
    await orig(filePath);
    await sealFromSession(recorder.getSession(), sidecarPath(filePath), {
      ...opts,
      source_path: filePath
    });
  };
  target[ATTACHED] = true;
  return recorder;
}

function openOptions(opts?: SealFromSessionOptions): OpenOptions {
  return {
    payload_mode: opts?.payload_mode ?? "commitments",
    include_wrap_io: opts?.include_wrap_io,
    fsync: opts?.fsync,
    emit: opts?.emit
  };
}

function sourcePathOf(ledgerPath: string, opts?: SealFromSessionOptions): string | undefined {
  if (opts?.source_path) {
    return opts.source_path;
  }
  if (ledgerPath.endsWith(".vrs.vrc") || ledgerPath.endsWith(".json.vrc")) {
    return ledgerPath.slice(0, -4);
  }
  return undefined;
}

function embedPayload(event: unknown, mode: "commitments" | "embedded"): JsonValue | undefined {
  if (mode !== "embedded") {
    return undefined;
  }
  return redactForEmbed(eventAsStored(event));
}

export async function sealFromSession(
  session: SessionData,
  ledgerPath: string,
  opts?: SealFromSessionOptions
): Promise<SealFromSessionResult> {
  if (poisonedLedgers.has(ledgerPath)) {
    throw new VisReceiptError("VRC2010", { detail: ledgerPath });
  }
  const includeWrapIo = Boolean(opts?.include_wrap_io);
  const payloadMode = opts?.payload_mode ?? "commitments";
  const admitted = admitSession(session, includeWrapIo);
  const existed = existsSync(ledgerPath);
  const open = openOptions(opts);
  const ledger = existed
    ? await ReceiptLedger.open(ledgerPath, open)
    : await ReceiptLedger.create(
        ledgerPath,
        {
          subject_id: session.sessionId,
          session_name: session.sessionName,
          agent_type: session.agentType,
          source_path: sourcePathOf(ledgerPath, opts),
          started_at: session.startedAt,
          ledger_id: ledgerIdFromSessionId(session.sessionId)
        },
        open
      );
  let appended = 0;
  try {
    const known = new Map<string, ReceiptRecord>();
    let hasSessionEnd = false;
    if (existed) {
      const run = await collectRotationRun(ledgerPath);
      if (run.fail) {
        throw new VisReceiptError("VRC1002", { detail: run.fail.broken_at?.reason });
      }
      for (const rec of run.records) {
        if (rec.freeze_point === "session_end") {
          hasSessionEnd = true;
        }
        const prev = known.get(rec.subject_id);
        if (!prev || rec.seq >= prev.seq) {
          known.set(rec.subject_id, rec);
        }
      }
    }
    for (const item of admitted) {
      const existing = known.get(item.event.eventId);
      if (existing) {
        if (existing.payload_sha256 === item.payload_sha256) {
          continue;
        }
        poisonedLedgers.add(ledgerPath);
        throw new VisReceiptError("VRC2010", {
          detail: item.event.eventId,
          expected: existing.payload_sha256,
          actual: item.payload_sha256
        });
      }
      const body = embedPayload(item.event, payloadMode);
      if (item.decision.kind === "link") {
        const rec = await ledger.append({
          subject_kind: item.decision.subject_kind,
          subject_id: item.event.eventId,
          payload_sha256: item.payload_sha256,
          payload: body
        });
        known.set(item.event.eventId, rec);
        appended += 1;
        continue;
      }
      const rec = await ledger.seal(
        item.decision.freeze_point as "tool_result" | "verdict" | "approval_granted",
        {
          subject_kind: item.decision.subject_kind,
          subject_id: item.event.eventId,
          payload_sha256: item.payload_sha256,
          payload: body ?? item.decision.pointer
        }
      );
      known.set(item.event.eventId, rec);
      appended += 1;
    }
    const forceEnd = Boolean(opts?.session_end) || session.endedAt !== undefined;
    if (forceEnd && !hasSessionEnd) {
      const rec = await ledger.seal("session_end", {
        subject_kind: "session",
        subject_id: session.sessionId,
        payload: sessionEndPointer(session)
      });
      known.set(session.sessionId, rec);
      appended += 1;
      hasSessionEnd = true;
    }
    return {
      last: ledger.head(),
      created: !existed,
      appended
    };
  } finally {
    await ledger.close();
  }
}

export function poisonLedger(ledgerPath: string): void {
  poisonedLedgers.add(ledgerPath);
}

export function isLedgerPoisoned(ledgerPath: string): boolean {
  return poisonedLedgers.has(ledgerPath);
}
