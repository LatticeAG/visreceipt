export const VRC_CODES = {
  VRC1001: 'VRC1001',
  VRC1002: 'VRC1002',
  VRC1003: 'VRC1003',
  VRC1004: 'VRC1004',
  VRC1005: 'VRC1005',
  VRC1006: 'VRC1006',
  VRC1007: 'VRC1007',
  VRC1008: 'VRC1008',
  VRC1009: 'VRC1009',
  VRC1010: 'VRC1010',
  VRC1011: 'VRC1011',
  VRC1012: 'VRC1012',
  VRC1013: 'VRC1013',
  VRC1014: 'VRC1014',
  VRC1015: 'VRC1015',
  VRC1016: 'VRC1016',
  VRC1017: 'VRC1017',
  VRC2001: 'VRC2001',
  VRC2002: 'VRC2002',
  VRC2003: 'VRC2003',
  VRC2004: 'VRC2004',
  VRC2010: 'VRC2010',
  VRC2011: 'VRC2011',
  VRC2012: 'VRC2012',
  VRC2013: 'VRC2013',
  VRC2014: 'VRC2014',
  VRC3001: 'VRC3001',
  VRC3002: 'VRC3002',
  VRCW01: 'VRCW01'
} as const;

export type VrcCode = (typeof VRC_CODES)[keyof typeof VRC_CODES];

const VRC_REASONS: Record<VrcCode, string> = {
  VRC1001: 'empty_ledger',
  VRC1002: 'hash_mismatch',
  VRC1003: 'not_canonical',
  VRC1004: 'truncated_tail',
  VRC1005: 'bad_genesis',
  VRC1006: 'path_escape',
  VRC1007: 'id_mismatch',
  VRC1008: 'bad_hash_encoding',
  VRC1009: 'time_regression',
  VRC1010: 'payload_mismatch',
  VRC1011: 'incomplete_commitment',
  VRC1012: 'genesis_mismatch',
  VRC1013: 'ledger_id_mismatch',
  VRC1014: 'seq_gap',
  VRC1015: 'prev_mismatch',
  VRC1016: 'head_mismatch',
  VRC1017: 'rotation_runaway',
  VRC2001: 'unsealed_subject',
  VRC2002: 'memory ledger in production',
  VRC2003: 'seal_expired',
  VRC2004: 'ledger_unverified',
  VRC2010: 'history_mutated',
  VRC2011: 'bad_webhook_sig',
  VRC2012: 'sig_missing',
  VRC2013: 'watch_inflight_fail',
  VRC2014: 'export_too_large',
  VRC3001: 'visreplay_peer_missing',
  VRC3002: 'sidecar_path_invalid',
  VRCW01: 'time_regression'
};

const EXIT_CHAIN_BROKEN: ReadonlySet<VrcCode> = new Set([
  VRC_CODES.VRC1001,
  VRC_CODES.VRC1002,
  VRC_CODES.VRC1007,
  VRC_CODES.VRC1008,
  VRC_CODES.VRC1012,
  VRC_CODES.VRC1013,
  VRC_CODES.VRC1014,
  VRC_CODES.VRC1015,
  VRC_CODES.VRC1016,
  VRC_CODES.VRC2010
]);

const EXIT_SCHEMA_CANONICAL: ReadonlySet<VrcCode> = new Set([
  VRC_CODES.VRC1003,
  VRC_CODES.VRC1004,
  VRC_CODES.VRC1005,
  VRC_CODES.VRC1006,
  VRC_CODES.VRC1009,
  VRC_CODES.VRC1011,
  VRC_CODES.VRC1017
]);

const EXIT_GATE: ReadonlySet<VrcCode> = new Set([
  VRC_CODES.VRC2001,
  VRC_CODES.VRC2003,
  VRC_CODES.VRC2004
]);

export function vrcMessage(code: VrcCode): string {
  return VRC_REASONS[code];
}

export function cliExitCode(code: VrcCode): number {
  if (EXIT_CHAIN_BROKEN.has(code)) {
    return 2;
  }
  if (EXIT_SCHEMA_CANONICAL.has(code)) {
    return 3;
  }
  if (code === VRC_CODES.VRC1010) {
    return 4;
  }
  if (EXIT_GATE.has(code)) {
    return 5;
  }
  if (code === VRC_CODES.VRC2012) {
    return 6;
  }
  return 1;
}

export interface VisReceiptErrorOptions {
  detail?: string;
  seq?: number;
  line?: number;
  expected?: string;
  actual?: string;
}

export class VisReceiptError extends Error {
  readonly code: VrcCode;
  readonly detail?: string;
  readonly seq?: number;
  readonly line?: number;
  readonly expected?: string;
  readonly actual?: string;

  constructor(code: VrcCode, options: VisReceiptErrorOptions = {}) {
    const reason = vrcMessage(code);
    const detail = options.detail;
    super(`${code} ${reason}${detail ? ': ' + detail : ''}`);
    this.name = 'VisReceiptError';
    this.code = code;
    this.detail = detail;
    this.seq = options.seq;
    this.line = options.line;
    this.expected = options.expected;
    this.actual = options.actual;
  }
}
