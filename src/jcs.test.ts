import { describe, expect, it } from "vitest";
import { selfTest, sha256Hex } from "./jcs.js";

describe("jcs", () => {
  it("selfTest passes", () => {
    expect(selfTest()).toEqual({ ok: true });
  });

  it('sha256Hex("{}") matches the frozen empty-object digest', () => {
    expect(sha256Hex("{}")).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });
});
