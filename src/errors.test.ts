import { describe, expect, it } from 'vitest';

import {
  cliExitCode,
  VisReceiptError,
  VRC_CODES,
  vrcMessage,
  type VrcCode
} from './errors.js';

const ALL_CODES = Object.values(VRC_CODES);

const EXIT_2: VrcCode[] = [
  'VRC1001',
  'VRC1002',
  'VRC1007',
  'VRC1008',
  'VRC1012',
  'VRC1013',
  'VRC1014',
  'VRC1015',
  'VRC1016',
  'VRC2010'
];

const EXIT_3: VrcCode[] = [
  'VRC1003',
  'VRC1004',
  'VRC1005',
  'VRC1006',
  'VRC1009',
  'VRC1011',
  'VRC1017'
];

const EXIT_5: VrcCode[] = ['VRC2001', 'VRC2003', 'VRC2004'];

describe('VisReceiptError', () => {
  it('constructs each code with .code and a message that starts with the code', () => {
    for (const code of ALL_CODES) {
      const err = new VisReceiptError(code);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('VisReceiptError');
      expect(err.code).toBe(code);
      expect(err.message.startsWith(code)).toBe(true);
      expect(err.message).toBe(`${code} ${vrcMessage(code)}`);
    }
  });

  it('appends detail after the reason', () => {
    const err = new VisReceiptError('VRC1002', {
      detail: 'seq 42',
      seq: 42,
      line: 42,
      expected: 'abc',
      actual: 'def'
    });
    expect(err.code).toBe('VRC1002');
    expect(err.message).toBe('VRC1002 hash_mismatch: seq 42');
    expect(err.seq).toBe(42);
    expect(err.line).toBe(42);
    expect(err.expected).toBe('abc');
    expect(err.actual).toBe('def');
  });

  it('keeps VRC2002 message matching memory ledger in production', () => {
    const err = new VisReceiptError('VRC2002');
    expect(err.code).toBe('VRC2002');
    expect(err.message).toContain('memory ledger in production');
  });
});

describe('cliExitCode', () => {
  it('maps chain-broken codes to 2', () => {
    for (const code of EXIT_2) {
      expect(cliExitCode(code)).toBe(2);
    }
  });

  it('maps schema and canonical codes to 3', () => {
    for (const code of EXIT_3) {
      expect(cliExitCode(code)).toBe(3);
    }
  });

  it('maps payload mismatch to 4', () => {
    expect(cliExitCode('VRC1010')).toBe(4);
  });

  it('maps gate fail codes to 5', () => {
    for (const code of EXIT_5) {
      expect(cliExitCode(code)).toBe(5);
    }
  });

  it('maps Phase 8 signature fail to 6', () => {
    expect(cliExitCode('VRC2012')).toBe(6);
  });

  it('maps remaining codes to 1', () => {
    expect(cliExitCode('VRC2002')).toBe(1);
    expect(cliExitCode('VRC2011')).toBe(1);
    expect(cliExitCode('VRC2013')).toBe(1);
    expect(cliExitCode('VRC2014')).toBe(1);
    expect(cliExitCode('VRC3001')).toBe(1);
    expect(cliExitCode('VRC3002')).toBe(1);
    expect(cliExitCode('VRCW01')).toBe(1);
  });
});
