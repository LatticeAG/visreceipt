import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyLedgerText } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const tamperDir = join(here, "..", "conformance", "tamper");

interface TamperFixture {
  id: string;
  reason: string;
  seq?: number;
  ndjson?: string;
  mode?: string;
  expect_head?: string;
  expect_head_reason?: string;
}

function loadFixtures(): TamperFixture[] {
  return readdirSync(tamperDir)
    .filter((name) => /^T\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(tamperDir, name), "utf8")) as TamperFixture);
}

describe("golden ledger", () => {
  it("verifyLedgerText(golden.ndjson) is ok at seq 5", () => {
    const text = readFileSync(join(tamperDir, "golden.ndjson"), "utf8");
    const result = verifyLedgerText(text);
    expect(result.ok).toBe(true);
    expect(result.seq).toBe(5);
    expect(result.broken_at).toBeNull();
  });
});

describe("tamper corpus", () => {
  const fixtures = loadFixtures();

  it("loads P1 and P3 cases including T09/T13", () => {
    const ids = fixtures.map((f) => f.id);
    expect(ids).toEqual([
      "T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08",
      "T09", "T10", "T11", "T12", "T13", "T14", "T15"
    ]);
  });

  for (const fixture of fixtures) {
    if (!fixture.ndjson) {
      it(`${fixture.id} ${fixture.reason} is a sidecar case`, () => {
        if (fixture.id === "T09") {
          expect(fixture.reason).toBe("payload_mismatch");
          expect(fixture.seq).toBe(3);
          expect(fixture.mode).toBe("with-payload");
        } else {
          expect(fixture.reason).toBe("history_mutated");
          expect(fixture.mode).toBe("attach");
        }
      });
      continue;
    }
    it(`${fixture.id} ${fixture.reason}`, () => {
      if (fixture.reason === "ok") {
        const internal = verifyLedgerText(fixture.ndjson!);
        expect(internal.ok).toBe(true);
        const headed = verifyLedgerText(fixture.ndjson!, { expectedHead: fixture.expect_head });
        expect(headed.ok).toBe(false);
        expect(headed.broken_at?.reason).toBe("head_mismatch");
        return;
      }
      const result = verifyLedgerText(fixture.ndjson!);
      expect(result.ok).toBe(false);
      expect(result.broken_at?.reason).toBe(fixture.reason);
      expect(result.broken_at?.seq).toBe(fixture.seq);
    });
  }
});
