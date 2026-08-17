import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("returns defaults when no file exists", () => {
    const cfg = loadConfig({ cwd: tmpdir(), env: {} });
    expect(cfg.schema_version).toBe(1);
    expect(cfg.ledger.payload_mode).toBe("commitments");
    expect(cfg.gate.max_age_ms).toBe(300000);
  });

  it("walks parents and rejects unknown keys", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-cfg-"));
    const child = join(dir, "nested");
    await writeFile(
      join(dir, "visreceipt.json"),
      `${JSON.stringify({ schema_version: 1, gate: { max_age_ms: 1000 } })}\n`,
      "utf8"
    );
    const cfg = loadConfig({ cwd: child, env: {} });
    expect(cfg.gate.max_age_ms).toBe(1000);

    const bad = join(dir, "bad.json");
    await writeFile(bad, `${JSON.stringify({ schema_version: 1, nope: true })}\n`, "utf8");
    expect(() => loadConfig({ cwd: dir, env: { VISRECEIPT_CONFIG: bad } })).toThrow(
      /invalid visreceipt.json/
    );
  });

  it("rejects CRLF", async () => {
    dir = await mkdtemp(join(tmpdir(), "vrc-cfg-crlf-"));
    const path = join(dir, "visreceipt.json");
    await writeFile(path, "{\r\n  \"schema_version\": 1\r\n}\r\n", "utf8");
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/LF/);
  });
});
