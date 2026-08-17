#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access, chmod, constants, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { verifyVrsPayloads } from "./admit.js";
import { sealFromSession } from "./attach.js";
import { loadConfig } from "./config.js";
import { exportRange, verifyExport } from "./export.js";
import { cliExitCode, VisReceiptError, type VrcCode } from "./errors.js";
import { assertSealed } from "./gate.js";
import { inspectLedger } from "./inspect.js";
import { selfTest } from "./jcs.js";
import { ReceiptLedger, repairLedgerFile, verifyFile } from "./ledger.js";
import { sidecarPath } from "./paths.js";
import { allowUnredacted, redactValue } from "./redact.js";
import { collectRotationRun } from "./rotate.js";
import type {
  FreezePoint,
  InspectResult,
  JsonValue,
  ReceiptRecord,
  SubjectInput,
  VerifyReason,
  VerifyResult
} from "./types.js";
import { loadVrs } from "./vrs.js";
import { watchDirectory } from "./watch.js";

const require = createRequire(import.meta.url);

const SEAL_FREEZE = new Set<string>([
  "belief_batch",
  "tool_result",
  "verdict",
  "session_end",
  "approval_granted",
  "effect_closed"
]);

const REASON_TO_CODE: Record<VerifyReason, VrcCode> = {
  empty_ledger: "VRC1001",
  hash_mismatch: "VRC1002",
  not_canonical: "VRC1003",
  truncated_tail: "VRC1004",
  bad_genesis: "VRC1005",
  path_escape: "VRC1006",
  id_mismatch: "VRC1007",
  bad_hash_encoding: "VRC1008",
  time_regression: "VRC1009",
  payload_mismatch: "VRC1010",
  incomplete_commitment: "VRC1011",
  genesis_mismatch: "VRC1012",
  ledger_id_mismatch: "VRC1013",
  seq_gap: "VRC1014",
  prev_mismatch: "VRC1015",
  head_mismatch: "VRC1016",
  kind_freeze_mismatch: "VRC1005",
  history_mutated: "VRC2010"
};

function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version;
    }
  } catch {
    // Missing package.json must not crash CLI construction.
  }
  return "0.0.0-unknown";
}

function writePeerVersion(name: string): void {
  try {
    const pkg = require(`${name}/package.json`) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      process.stdout.write(`${name} ${pkg.version}\n`);
    }
  } catch {
    // optional peer missing
  }
}

function parseSubject(text: string): SubjectInput {
  const parsed = JSON.parse(text) as SubjectInput;
  if (typeof parsed.subject_kind !== "string" || typeof parsed.subject_id !== "string") {
    throw new Error("event must include subject_kind and subject_id");
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function applySubject(
  ledger: ReceiptLedger,
  subject: SubjectInput,
  freezePoint?: string
): Promise<ReceiptRecord> {
  if (!freezePoint || freezePoint === "event") {
    return ledger.append(subject);
  }
  if (SEAL_FREEZE.has(freezePoint)) {
    return ledger.seal(freezePoint as Exclude<FreezePoint, "event" | "rotation" | "continuation">, subject);
  }
  throw new Error(`invalid freeze-point: ${freezePoint}`);
}

function printSeal(
  record: { seq: number; hash: string; receipt_id: string },
  json: boolean
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...record, chain_head: record.hash })}\n`);
    return;
  }
  process.stdout.write(
    `sealed seq=${record.seq} head=${record.hash} receipt_id=${record.receipt_id}\n`
  );
}

function printBroken(result: VerifyResult): void {
  const broken = result.broken_at;
  if (!broken) {
    return;
  }
  const code = REASON_TO_CODE[broken.reason] ?? "VRC1002";
  process.stderr.write(
    `${code} ${broken.reason} at seq=${broken.seq} line=${broken.line} kind=${broken.kind}\n`
  );
  process.stderr.write(`verified_through_seq=${result.verified_through_seq}\n`);
  if (broken.expected !== undefined || broken.actual !== undefined) {
    process.stderr.write(`expected=${broken.expected ?? ""} actual=${broken.actual ?? ""}\n`);
  }
}

function setVerifyExit(result: VerifyResult): void {
  if (result.ok) {
    process.exitCode = 0;
    return;
  }
  const reason = result.broken_at?.reason;
  const code = reason ? REASON_TO_CODE[reason] ?? "VRC1002" : "VRC1002";
  process.exitCode = cliExitCode(code);
}

async function writePrivateFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function wantsUnredacted(opts: { noRedact?: boolean; redact?: boolean }): boolean {
  if (opts.noRedact === true) {
    return true;
  }
  return opts.redact === false;
}

function presentInspect(result: InspectResult, noRedact: boolean): InspectResult {
  if (noRedact && allowUnredacted()) {
    return result;
  }
  return redactValue(result as unknown as JsonValue) as unknown as InspectResult;
}

async function runSealFromVrs(opts: {
  fromVrs: string;
  out?: string;
  ledger?: string;
  embedPayload?: boolean;
  includeWrapIo?: boolean;
  sessionEnd?: boolean;
  json?: boolean;
}): Promise<void> {
  const session = await loadVrs(opts.fromVrs);
  const out = opts.out ?? opts.ledger ?? sidecarPath(opts.fromVrs);
  const result = await sealFromSession(session, out, {
    payload_mode: opts.embedPayload ? "embedded" : "commitments",
    include_wrap_io: Boolean(opts.includeWrapIo),
    session_end: Boolean(opts.sessionEnd),
    source_path: opts.fromVrs
  });
  printSeal(result.last, Boolean(opts.json));
}

async function runSeal(opts: {
  ledger?: string;
  event?: string;
  stdin?: boolean;
  freezePoint?: string;
  sessionId?: string;
  json?: boolean;
  fromVrs?: string;
  out?: string;
  embedPayload?: boolean;
  includeWrapIo?: boolean;
  sessionEnd?: boolean;
}): Promise<void> {
  if (opts.fromVrs) {
    await runSealFromVrs({
      fromVrs: opts.fromVrs,
      out: opts.out,
      ledger: opts.ledger,
      embedPayload: opts.embedPayload,
      includeWrapIo: opts.includeWrapIo,
      sessionEnd: opts.sessionEnd,
      json: opts.json
    });
    return;
  }
  if (!opts.ledger) {
    throw new Error("seal requires --ledger or --from-vrs");
  }
  if (Boolean(opts.event) === Boolean(opts.stdin)) {
    throw new Error("seal requires exactly one of --event or --stdin");
  }
  const exists = existsSync(opts.ledger);
  if (!exists && !opts.sessionId) {
    throw new Error("creating a ledger requires --session-id");
  }
  const ledger = exists
    ? await ReceiptLedger.open(opts.ledger)
    : await ReceiptLedger.create(opts.ledger, { subject_id: opts.sessionId! });
  try {
    if (opts.event) {
      const subject = parseSubject(readFileSync(opts.event, "utf8"));
      const record = await applySubject(ledger, subject, opts.freezePoint);
      printSeal(record, Boolean(opts.json));
      return;
    }
    const text = await readStdin();
    const lines = text.split(/\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new Error("stdin contained no SubjectInput lines");
    }
    let last: ReceiptRecord | undefined;
    for (const line of lines) {
      last = await applySubject(ledger, parseSubject(line), opts.freezePoint);
      printSeal(last, Boolean(opts.json));
    }
  } finally {
    await ledger.close();
  }
}

async function runVerify(
  path: string | undefined,
  opts: {
    expectHead?: string;
    expectStartPrev?: string;
    strictTime?: boolean;
    repairTail?: boolean;
    json?: boolean;
    withPayload?: boolean;
    vrs?: string;
    export?: string;
  }
): Promise<void> {
  if (opts.export) {
    if (path) {
      throw new Error("verify --export does not take a ledger path");
    }
    const text = readFileSync(opts.export, "utf8");
    const slice: unknown = JSON.parse(text);
    const result = verifyExport(slice, {
      expectedHead: opts.expectHead,
      expectedStartPrev: opts.expectStartPrev
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (!result.ok) {
      printBroken(result);
    }
    setVerifyExit(result);
    return;
  }
  if (!path) {
    throw new Error("verify requires <path.vrc> or --export");
  }
  if (opts.withPayload && !opts.vrs) {
    throw new Error("verify --with-payload requires --vrs");
  }
  if (opts.repairTail) {
    await repairLedgerFile(path);
  }
  let result = await verifyFile(path, {
    expectedHead: opts.expectHead,
    strictTime: Boolean(opts.strictTime)
  });
  if (result.ok && opts.withPayload && opts.vrs) {
    const session = await loadVrs(opts.vrs);
    const run = await collectRotationRun(path);
    if (run.fail) {
      result = run.fail;
    } else {
      result = verifyVrsPayloads(run.records, session, result);
    }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (!result.ok) {
    printBroken(result);
  }
  setVerifyExit(result);
}

async function runExport(
  path: string,
  opts: {
    fromSeq?: string | number;
    toSeq?: string | number;
    out?: string;
    embedPayload?: boolean;
    vrs?: string;
  }
): Promise<void> {
  const fromSeq = Number(opts.fromSeq);
  const toSeq = Number(opts.toSeq);
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) {
    throw new Error("export requires --from-seq and --to-seq");
  }
  if (opts.embedPayload && !opts.vrs) {
    throw new Error("export --embed-payload requires --vrs");
  }
  const run = await collectRotationRun(path);
  if (run.fail) {
    printBroken(run.fail);
    setVerifyExit(run.fail);
    return;
  }
  const slice = await exportRange(run.records, fromSeq, toSeq, {
    embedPayload: Boolean(opts.embedPayload),
    vrsPath: opts.vrs,
    files: run.files
  });
  const text = `${JSON.stringify(slice)}\n`;
  if (opts.out) {
    await writePrivateFile(opts.out, text);
    return;
  }
  process.stdout.write(text);
}

async function runInspect(
  path: string,
  id: string | undefined,
  opts: {
    head?: boolean;
    seq?: string | number;
    vrs?: string;
    noRedact?: boolean;
    redact?: boolean;
  }
): Promise<void> {
  const run = await collectRotationRun(path);
  if (run.fail) {
    printBroken(run.fail);
    setVerifyExit(run.fail);
    return;
  }
  if (opts.head) {
    const last = run.records[run.records.length - 1];
    if (!last) {
      throw new VisReceiptError("VRC1001");
    }
    process.stdout.write(
      `seq=${last.seq} hash=${last.hash} receipt_id=${last.receipt_id} ledger_id=${last.ledger_id}\n`
    );
    return;
  }
  const key = opts.seq !== undefined && opts.seq !== "" ? opts.seq : id;
  if (key === undefined || key === "") {
    throw new Error("inspect requires a receipt_id, seq, --seq, or --head");
  }
  const result = await inspectLedger(run.records, key, { vrsPath: opts.vrs });
  const shown = presentInspect(result, wantsUnredacted(opts));
  process.stdout.write(`${JSON.stringify(shown)}\n`);
}

async function runGate(opts: {
  ledger?: string;
  subjectId?: string;
  freezePoint?: string;
  maxAgeMs?: string | number;
  soft?: boolean;
}): Promise<void> {
  if (!opts.ledger || !opts.subjectId) {
    throw new Error("gate requires --ledger and --subject-id");
  }
  const cfg = loadConfig();
  const maxAge =
    opts.maxAgeMs === undefined || opts.maxAgeMs === ""
      ? cfg.gate.max_age_ms
      : Number(opts.maxAgeMs);
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    throw new Error("gate --max-age-ms must be a non-negative number");
  }
  const ledger = await ReceiptLedger.open(opts.ledger);
  try {
    const record = await assertSealed(ledger, {
      subject_id: opts.subjectId,
      freeze_point: opts.freezePoint as FreezePoint | undefined,
      max_age_ms: maxAge
    });
    printSeal(record, false);
  } catch (error) {
    if (opts.soft && error instanceof VisReceiptError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 0;
      return;
    }
    throw error;
  } finally {
    await ledger.close();
  }
}

async function runDoctor(opts: { ledger?: string }): Promise<void> {
  const major = Number.parseInt(process.versions.node, 10);
  if (!Number.isFinite(major) || major < 20) {
    process.stderr.write("node >=20 required\n");
    process.exitCode = 1;
    return;
  }
  try {
    await access(process.cwd(), constants.W_OK);
  } catch {
    process.stderr.write("cwd is not writable\n");
    process.exitCode = 1;
    return;
  }
  const jcs = selfTest();
  if (!jcs.ok) {
    process.stdout.write("VRC1003\n");
    process.exitCode = 3;
    return;
  }
  try {
    require("@latticeag/visreplay/package.json");
  } catch {
    // optional peer
  }
  try {
    require("@latticeag/events/package.json");
  } catch {
    // optional peer
  }
  try {
    loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.ledger) {
    const result = await verifyFile(opts.ledger);
    if (!result.ok) {
      const reason = result.broken_at?.reason;
      const code = reason ? REASON_TO_CODE[reason] ?? "VRC1002" : "VRC1002";
      process.stdout.write(`${code}\n`);
      process.exitCode = cliExitCode(code);
      return;
    }
  }
  process.stdout.write("ok\n");
  process.exitCode = 0;
}

export function createProgram(): Command {
  const version = readPackageVersion();
  const program = new Command();

  program
    .name("visreceipt")
    .description("LatticeAG VisReceipt attested evidence ledger")
    .version(version)
    .exitOverride();

  program
    .command("version")
    .description("Print package version")
    .action(() => {
      process.stdout.write(`${version}\n`);
      writePeerVersion("@latticeag/visreplay");
      writePeerVersion("@latticeag/events");
    });

  program
    .command("seal")
    .description("Append or seal a subject onto a ledger")
    .option("--from-vrs <path>", "seal from a VisReplay session.vrs")
    .option("--out <path>", "ledger output path for --from-vrs")
    .option("--embed-payload", "embed event bodies on --from-vrs")
    .option("--include-wrap-io", "admit wrap input/output events")
    .option("--session-end", "force a session_end seal")
    .option("--ledger <path>", "ledger path (.vrc)")
    .option("--event <path>", "SubjectInput JSON file")
    .option("--stdin", "read NDJSON SubjectInput from stdin")
    .option("--freeze-point <freeze>", "seal freeze point (omit to append a link)")
    .option("--session-id <id>", "required when creating a new ledger")
    .option("--json", "print ReceiptRecord plus chain_head")
    .action(async (opts: {
      ledger?: string;
      event?: string;
      stdin?: boolean;
      freezePoint?: string;
      sessionId?: string;
      json?: boolean;
      fromVrs?: string;
      out?: string;
      embedPayload?: boolean;
      includeWrapIo?: boolean;
      sessionEnd?: boolean;
    }) => {
      await runSeal(opts);
    });

  program
    .command("verify")
    .description("Verify a ledger chain")
    .argument("[path]", "ledger path (.vrc)")
    .option("--export <slice>", "verify a visreceipt/export/1.0 slice")
    .option("--expect-head <hex>", "require this chain head")
    .option("--expect-start-prev <hex>", "require export start_prev_hash")
    .option("--with-payload", "recompute linked .vrs event hashes")
    .option("--vrs <path>", "VisReplay session for --with-payload")
    .option("--strict-time", "fail on non-monotonic ts")
    .option("--repair-tail", "truncate to last complete JCS line")
    .option("--json", "print VerifyResult")
    .action(async (
      path: string | undefined,
      opts: {
        export?: string;
        expectHead?: string;
        expectStartPrev?: string;
        strictTime?: boolean;
        repairTail?: boolean;
        json?: boolean;
        withPayload?: boolean;
        vrs?: string;
      }
    ) => {
      await runVerify(path, opts);
    });

  program
    .command("export")
    .description("Export a subchain slice")
    .argument("<path>", "ledger path (.vrc)")
    .requiredOption("--from-seq <n>", "first seq inclusive", (value: string) => Number(value))
    .requiredOption("--to-seq <n>", "last seq inclusive", (value: string) => Number(value))
    .option("--out <path>", "write slice JSON (default stdout)")
    .option("--embed-payload", "copy matching .vrs bodies into the slice")
    .option("--vrs <path>", "VisReplay session for --embed-payload")
    .action(async (path: string, opts: {
      fromSeq?: number;
      toSeq?: number;
      out?: string;
      embedPayload?: boolean;
      vrs?: string;
    }) => {
      await runExport(path, opts);
    });

  program
    .command("inspect")
    .description("Inspect a receipt or the chain head")
    .argument("<path>", "ledger path (.vrc)")
    .argument("[id]", "receipt_id or seq")
    .option("--head", "print seq, hash, receipt_id, ledger_id")
    .option("--seq <n>", "lookup by seq")
    .option("--vrs <path>", "join VisReplay eventId to subject_id")
    .option("--no-redact", "print unredacted bodies when allowed")
    .action(async (
      path: string,
      id: string | undefined,
      opts: {
        head?: boolean;
        seq?: string;
        vrs?: string;
        noRedact?: boolean;
        redact?: boolean;
      }
    ) => {
      await runInspect(path, id, opts);
    });

  program
    .command("gate")
    .description("Require a matching freeze-point seal")
    .requiredOption("--ledger <path>", "ledger path (.vrc)")
    .requiredOption("--subject-id <id>", "subject to gate on")
    .option("--freeze-point <freeze>", "freeze point (default belief_batch)")
    .option("--max-age-ms <ms>", "max seal age, 0 skips")
    .option("--soft", "print gate errors and exit 0")
    .action(async (opts: {
      ledger?: string;
      subjectId?: string;
      freezePoint?: string;
      maxAgeMs?: string;
      soft?: boolean;
    }) => {
      await runGate(opts);
    });

  program
    .command("doctor")
    .description("Check local runtime and optional ledger")
    .option("--ledger <path>", "verify this ledger")
    .action(async (opts: { ledger?: string }) => {
      await runDoctor(opts);
    });

  program
    .command("watch")
    .description("Watch a directory for .vrs files and seal sidecars")
    .argument("<dir>", "directory of .vrs files")
    .option("--debounce-ms <ms>", "debounce milliseconds", (value: string) => Number(value), 200)
    .option("--recursive", "watch one extra directory level")
    .option("--max-file-bytes <n>", "session file size cap", (value: string) => Number(value))
    .option("--max-events <n>", "session event cap", (value: string) => Number(value))
    .action(async (dir: string, opts: {
      debounceMs?: number;
      recursive?: boolean;
      maxFileBytes?: number;
      maxEvents?: number;
    }) => {
      const handle = watchDirectory(dir, {
        debounceMs: Number.isFinite(opts.debounceMs) ? opts.debounceMs : 200,
        recursive: Boolean(opts.recursive),
        maxFileBytes: opts.maxFileBytes,
        maxEvents: opts.maxEvents
      });
      await new Promise<void>((resolve) => {
        const stop = () => {
          void handle.flush().finally(() => {
            handle.close();
            process.exitCode = 0;
            resolve();
          });
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  return program;
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = 0;
  const program = createProgram();
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof VisReceiptError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = cliExitCode(error.code);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function isExecutedAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isExecutedAsCli()) {
  void runCli().catch((error: unknown) => {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof VisReceiptError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = cliExitCode(error.code);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
