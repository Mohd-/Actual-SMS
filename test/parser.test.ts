import { banks } from './fixtures/banks.js';
import { describe, expect, it } from 'vitest';
import { normalizeText, PARSER_REVISION, parseSms } from '../src/parser.js';
import { smsFixtures } from './fixtures/sms.js';

describe('SMS parser fixture corpus', () => {
  it.each(smsFixtures)('$provenance: $name', ({ sender, message, receivedAt, expected }) => {
    expect(parseSms(message, receivedAt, banks, sender)).toStrictEqual(expected);
  });

  it('tracks the parser release represented by the corpus', () => {
    expect(PARSER_REVISION).toBe(15);
  });
});

describe('SMS normalization', () => {
  it('normalizes Arabic digits and separators', () => {
    expect(normalizeText('١٬٢٣٤٫٥٦')).toBe('1234.56');
  });
});

describe('routing identifier regressions', () => {
  it('does not interpret By inside Ruby as an account label', () => {
    expect(
      parseSms(
        'Purchase at Ruby 1234 Amount: SAR 10 Card:8107',
        '2026-08-22T10:00:00Z',
        banks,
        'SAB',
      ),
    ).toMatchObject({ type: 'transaction', transaction: { accountAlias: '8107' } });
  });
  it.each(['IBAN:', 'To:'])('preserves a grouped IBAN suffix in %s', label => {
    expect(
      parseSms(
        `Outgoing transfer From: 5202 ${label} SA03 8000 0000 6080 1016 7404 Bank 123 Amount: SAR 100`,
        '2026-08-22T10:00:00Z',
        banks,
        'SAB',
      ),
    ).toMatchObject({ type: 'transaction', transaction: { transferCounterpartyAlias: '7404' } });
  });
});
