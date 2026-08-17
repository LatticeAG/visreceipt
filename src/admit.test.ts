import { describe, expect, it } from "vitest";

import { admitEvent, admitSession, toolResultPointer } from "./admit.js";
import { canonicalize } from "./jcs.js";
import type { JsonValue } from "./types.js";
import type { SessionData, VrsEvent } from "./vrs.js";

function event(partial: Partial<VrsEvent> & Pick<VrsEvent, "type" | "eventId">): VrsEvent {
  return {
    index: 0,
    timestamp: "2026-08-17T14:48:00.000Z",
    ...partial
  };
}

describe("admitEvent D10", () => {
  it("admits tool_call as a link", () => {
    const decision = admitEvent(event({ type: "tool_call", eventId: "evt_c", name: "run" }));
    expect(decision).toEqual({
      kind: "link",
      freeze_point: "event",
      subject_kind: "tool_call"
    });
  });

  it("admits reasoning including decisions as a link", () => {
    const decision = admitEvent(
      event({
        type: "reasoning",
        eventId: "evt_r",
        content: "go",
        metadata: { visreplay: { schema: "visreplay/decision/1.0", kind: "decision", believed: true } }
      })
    );
    expect(decision?.subject_kind).toBe("reasoning");
    expect(decision?.kind).toBe("link");
  });

  it("admits error as a link", () => {
    expect(admitEvent(event({ type: "error", eventId: "evt_e", error: "boom" }))?.subject_kind).toBe(
      "error"
    );
  });

  it("seals tool_result and never skips that freeze", () => {
    const ev = event({ type: "tool_result", eventId: "evt_t", result: { ok: true }, name: "run" });
    const decision = admitEvent(ev);
    expect(decision?.kind).toBe("seal");
    expect(decision?.freeze_point).toBe("tool_result");
    expect(decision?.subject_kind).toBe("tool_result");
    const pointer = toolResultPointer(ev);
    expect(pointer).toEqual({
      visreplay_event_id: "evt_t",
      index: 0,
      type: "tool_result",
      name: "run",
      vrs_index_ok: true
    });
    expect(canonicalize(pointer as unknown as JsonValue).length).toBeLessThanOrEqual(4096);
  });

  it("skips input and output unless include_wrap_io", () => {
    const input = event({ type: "input", eventId: "evt_i", content: "hi" });
    const output = event({ type: "output", eventId: "evt_o", content: "bye" });
    expect(admitEvent(input)).toBeUndefined();
    expect(admitEvent(output)).toBeUndefined();
    expect(admitEvent(input, true)).toMatchObject({
      kind: "link",
      freeze_point: "event",
      subject_kind: "session_event"
    });
    expect(admitEvent(output, true)?.subject_kind).toBe("session_event");
  });

  it("admits extra type strings when present", () => {
    expect(admitEvent(event({ type: "belief_extracted", eventId: "evt_b" }))?.subject_kind).toBe(
      "belief"
    );
    expect(admitEvent(event({ type: "verdict", eventId: "evt_v" }))).toMatchObject({
      kind: "seal",
      freeze_point: "verdict",
      subject_kind: "verdict"
    });
    expect(admitEvent(event({ type: "approval_granted", eventId: "evt_a" }))).toMatchObject({
      kind: "seal",
      freeze_point: "approval_granted",
      subject_kind: "approval"
    });
    expect(
      admitEvent(event({ type: "compensation_executed", eventId: "evt_x" }))?.subject_kind
    ).toBe("compensation");
  });

  it("admitSession skips wrap io by default", () => {
    const session: SessionData = {
      $schema: "visreplay/session/1.0",
      sessionId: "ses_1",
      sessionName: "s",
      agentType: "custom",
      startedAt: "2026-08-17T14:48:00.000Z",
      events: [
        event({ type: "input", eventId: "evt_i", index: 0, content: "in" }),
        event({ type: "tool_call", eventId: "evt_c", index: 1, name: "run", arguments: {} }),
        event({ type: "tool_result", eventId: "evt_t", index: 2, result: 1 }),
        event({ type: "output", eventId: "evt_o", index: 3, content: "out" })
      ]
    };
    const skipped = admitSession(session, false);
    expect(skipped.map((item) => item.event.type)).toEqual(["tool_call", "tool_result"]);
    const included = admitSession(session, true);
    expect(included.map((item) => item.event.type)).toEqual([
      "input",
      "tool_call",
      "tool_result",
      "output"
    ]);
  });
});
