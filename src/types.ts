import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject {
  [key: string]: JsonValue;
}

export const LEDGER_VERSION = "visreceipt/v1" as const;

export type RecordKind =
  | "genesis"
  | "link"
  | "seal"
  | "rotation"
  | "continuation";

export const RECORD_KINDS: readonly RecordKind[] = [
  "genesis",
  "link",
  "seal",
  "rotation",
  "continuation"
];

export type FreezePoint =
  | "session_start"
  | "belief_batch"
  | "tool_result"
  | "verdict"
  | "session_end"
  | "approval_granted"
  | "effect_closed"
  | "event"
  | "rotation"
  | "continuation";

export type SubjectKind =
  | "session"
  | "session_event"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "error"
  | "belief"
  | "belief_batch"
  | "verdict"
  | "approval"
  | "compensation"
  | "effect"
  | "ledger";

export interface Commitment {
  v: typeof LEDGER_VERSION;
  kind: RecordKind;
  ledger_id: string;
  seq: number;
  ts: string;
  nonce: string;
  prev_hash: string;
  freeze_point: FreezePoint;
  subject_kind: SubjectKind;
  subject_id: string;
  payload_sha256: string;
}

export const COMMITMENT_KEYS = [
  "v",
  "kind",
  "ledger_id",
  "seq",
  "ts",
  "nonce",
  "prev_hash",
  "freeze_point",
  "subject_kind",
  "subject_id",
  "payload_sha256"
] as const satisfies readonly (keyof Commitment)[];

export interface ReceiptRecord extends Commitment {
  receipt_id: string;
  hash: string;
  payload?: JsonValue;
  next_path?: string;
  file_index?: number;
  sig?: string;
  effect_id?: string;
  seal_hash?: string;
  anchor_seq?: number;
}

const KIND_FREEZE: Record<RecordKind, readonly FreezePoint[]> = {
  genesis: ["session_start"],
  link: ["event"],
  seal: ["belief_batch", "tool_result", "verdict", "session_end", "approval_granted", "effect_closed"],
  rotation: ["rotation"],
  continuation: ["continuation"]
};

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === "string" && (RECORD_KINDS as readonly string[]).includes(value);
}

export function assertKindFreeze(kind: unknown, freeze: unknown): boolean {
  if (!isRecordKind(kind) || typeof freeze !== "string") {
    return false;
  }
  return (KIND_FREEZE[kind] as readonly string[]).includes(freeze);
}

export type VerifyReason =
  | "empty_ledger"
  | "bad_genesis"
  | "genesis_mismatch"
  | "hash_mismatch"
  | "id_mismatch"
  | "payload_mismatch"
  | "seq_gap"
  | "prev_mismatch"
  | "ledger_id_mismatch"
  | "path_escape"
  | "truncated_tail"
  | "not_canonical"
  | "bad_hash_encoding"
  | "time_regression"
  | "head_mismatch"
  | "incomplete_commitment"
  | "kind_freeze_mismatch"
  | "history_mutated";

export interface BrokenAt {
  seq: number;
  line: number;
  kind: RecordKind | "unknown";
  reason: VerifyReason;
  expected?: string;
  actual?: string;
}

export interface VerifyResult {
  ok: boolean;
  ledger_id?: string;
  chain_head?: string;
  seq?: number;
  record_count: number;
  verified_through_seq: number;
  broken_at: BrokenAt | null;
  files_walked: string[];
}

export const visreceiptConfigSchema = z.object({
  $schema: z.string().url().optional(),
  schema_version: z.literal(1),
  ledger: z.object({
    payload_mode: z.enum(["commitments", "embedded"]).default("commitments"),
    fsync: z.enum(["always", "interval"]).default("always"),
    fsync_interval_ms: z.number().int().min(20).max(5000).default(200),
    max_ledger_bytes: z.number().int().min(65536).max(1073741824).default(67108864),
    max_records: z.number().int().min(16).max(500000).default(100000),
    include_wrap_io: z.boolean().default(false)
  }).strict().default({}),
  watch: z.object({
    debounce_ms: z.number().int().min(0).max(5000).default(200)
  }).strict().default({}),
  ingest: z.object({
    bind: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(9848)
  }).strict().default({}),
  gate: z.object({
    max_age_ms: z.number().int().min(0).max(86400000).default(300000)
  }).strict().default({})
}).strict();

export type VisreceiptConfig = z.infer<typeof visreceiptConfigSchema>;

export interface SessionEventLite {
  eventId: string;
  index: number;
  timestamp: string;
  type: string;
  name?: string;
  arguments?: JsonObject;
  result?: JsonValue;
  content?: JsonValue;
  error?: string;
  method?: string;
  metadata?: JsonObject;
}

export interface ToolResultPointer {
  visreplay_event_id: string;
  index: number;
  type: "tool_result";
  name?: string;
  vrs_index_ok: true;
}

export function isVrsPointer(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return rec.vrs_index_ok === true && typeof rec.visreplay_event_id === "string";
}

export interface OpenOptions {
  payload_mode?: "commitments" | "embedded";
  include_wrap_io?: boolean;
  fsync?: "always" | "interval";
  fsync_interval_ms?: number;
  max_ledger_bytes?: number;
  max_records?: number;
  run_id?: string;
  session_id?: string;
  emit?: (envelope: unknown) => void | Promise<void>;
}

export interface GenesisInput {
  subject_id: string;
  session_name?: string;
  agent_type?: string;
  source_path?: string;
  started_at?: string;
  ledger_id?: string;
}

export interface SubjectInput {
  subject_kind: SubjectKind;
  subject_id: string;
  payload?: JsonValue;
  raw_payload_bytes?: Uint8Array;
  payload_sha256?: string;
  visreplay_event?: SessionEventLite;
  effect_id?: string;
  seal_hash?: string;
  anchor_seq?: number;
  envelope_id?: string;
}

export interface SubchainExport {
  $schema: "visreceipt/export/1.0";
  ledger_id: string;
  from_seq: number;
  to_seq: number;
  start_prev_hash: string;
  end_hash: string;
  record_count: number;
  payload_mode: "commitments" | "embedded";
  created_at: string;
  files: string[];
  records: ReceiptRecord[];
  verify_key?: string;
}

export interface InspectResult {
  record: ReceiptRecord;
  prev_seq: number | null;
  next_seq: number | null;
  payload_body?: JsonValue;
  vrs_event?: SessionEventLite;
}

export interface GateQuery {
  freeze_point?: FreezePoint;
  subject_kind?: SubjectKind;
  subject_id: string;
  max_age_ms?: number;
}

export type ReceiptTier =
  | "agent_asserted"
  | "gateway_verified"
  | "downstream_attested";

export interface ReceiptIssuedPayload {
  request_id: string;
  execution_id: string;
  tier: ReceiptTier;
  action: string;
  issued_at: string;
  payload_sha256: string;
  receipt_id: string;
  ledger_id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  chain_head: string;
  freeze_point: FreezePoint;
  subject_kind: SubjectKind;
  subject_id: string;
  nonce: string;
  sidecar_path?: string;
  effect_id?: string;
  seal_hash?: string;
  anchor_seq?: number;
}

export interface ReceiptIssued {
  name: "receipt_issued";
  payload: ReceiptIssuedPayload;
}

export type ReceiptIssuedEvent = ReceiptIssued;
