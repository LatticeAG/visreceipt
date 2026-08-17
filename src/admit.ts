import { hashVrsEvent } from "./vrs.js";
import type { SessionData, VrsEvent } from "./vrs.js";
import type {
  FreezePoint,
  JsonObject,
  ReceiptRecord,
  SubjectKind,
  ToolResultPointer,
  VerifyResult
} from "./types.js";

const PAYLOAD_SUBJECTS: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_result",
  "reasoning",
  "error",
  "session_event",
  "belief",
  "verdict",
  "approval",
  "compensation"
]);

export type AdmitKind = "link" | "seal";

export interface AdmitDecision {
  kind: AdmitKind;
  freeze_point: FreezePoint;
  subject_kind: SubjectKind;
  pointer?: JsonObject;
}

export interface AdmittedEvent {
  event: VrsEvent;
  decision: AdmitDecision;
  payload_sha256: string;
}

function typeOrName(event: VrsEvent): { type: string; name: string } {
  return {
    type: event.type,
    name: typeof event.name === "string" ? event.name : ""
  };
}

function matches(event: VrsEvent, label: string): boolean {
  const { type, name } = typeOrName(event);
  return type === label || name === label;
}

export function toolResultPointer(event: VrsEvent): ToolResultPointer {
  const pointer: ToolResultPointer = {
    visreplay_event_id: event.eventId,
    index: event.index,
    type: "tool_result",
    vrs_index_ok: true
  };
  if (typeof event.name === "string") {
    pointer.name = event.name;
  }
  return pointer;
}

function eventPointer(event: VrsEvent, type: string): JsonObject {
  const pointer: JsonObject = {
    visreplay_event_id: event.eventId,
    index: event.index,
    type,
    vrs_index_ok: true
  };
  if (typeof event.name === "string") {
    pointer.name = event.name;
  }
  return pointer;
}

export function admitEvent(event: VrsEvent, includeWrapIo = false): AdmitDecision | undefined {
  if (matches(event, "tool_result")) {
    return {
      kind: "seal",
      freeze_point: "tool_result",
      subject_kind: "tool_result",
      pointer: toolResultPointer(event) as unknown as JsonObject
    };
  }
  if (matches(event, "verdict")) {
    return {
      kind: "seal",
      freeze_point: "verdict",
      subject_kind: "verdict",
      pointer: eventPointer(event, "verdict")
    };
  }
  if (matches(event, "approval_granted")) {
    return {
      kind: "seal",
      freeze_point: "approval_granted",
      subject_kind: "approval",
      pointer: eventPointer(event, "approval_granted")
    };
  }
  if (event.type === "tool_call") {
    return { kind: "link", freeze_point: "event", subject_kind: "tool_call" };
  }
  if (event.type === "reasoning") {
    return { kind: "link", freeze_point: "event", subject_kind: "reasoning" };
  }
  if (event.type === "error") {
    return { kind: "link", freeze_point: "event", subject_kind: "error" };
  }
  if (matches(event, "belief_extracted")) {
    return { kind: "link", freeze_point: "event", subject_kind: "belief" };
  }
  if (matches(event, "compensation_executed")) {
    return { kind: "link", freeze_point: "event", subject_kind: "compensation" };
  }
  if (event.type === "input" || event.type === "output") {
    if (!includeWrapIo) {
      return undefined;
    }
    return { kind: "link", freeze_point: "event", subject_kind: "session_event" };
  }
  return undefined;
}

export function admitSession(session: SessionData, includeWrapIo = false): AdmittedEvent[] {
  const admitted: AdmittedEvent[] = [];
  for (const event of session.events) {
    const decision = admitEvent(event, includeWrapIo);
    if (!decision) {
      continue;
    }
    admitted.push({
      event,
      decision,
      payload_sha256: hashVrsEvent(event)
    });
  }
  return admitted;
}

export function sessionEndPointer(session: SessionData): JsonObject {
  const pointer: JsonObject = { session_id: session.sessionId };
  if (session.endedAt !== undefined) {
    pointer.ended_at = session.endedAt;
  }
  return pointer;
}

export function verifyVrsPayloads(
  records: ReceiptRecord[],
  session: SessionData,
  chain: VerifyResult
): VerifyResult {
  if (!chain.ok) {
    return chain;
  }
  const byId = new Map(session.events.map((event) => [event.eventId, event]));
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (!PAYLOAD_SUBJECTS.has(rec.subject_kind)) {
      continue;
    }
    const event = byId.get(rec.subject_id);
    const actual = event === undefined ? "" : hashVrsEvent(event);
    if (event === undefined || actual !== rec.payload_sha256) {
      return {
        ...chain,
        ok: false,
        verified_through_seq: rec.seq - 1,
        broken_at: {
          seq: rec.seq,
          line: i + 1,
          kind: rec.kind,
          reason: "payload_mismatch",
          expected: rec.payload_sha256,
          actual: actual.length > 0 ? actual : undefined
        }
      };
    }
  }
  return chain;
}
