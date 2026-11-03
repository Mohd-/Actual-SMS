import { banks, parsing } from './fixtures/banks.js';
import { describe, expect, it } from 'vitest';
import { normalizeText, PARSER_REVISION, parseSms } from '../src/parser.js';
import { smsFixtures } from './fixtures/sms.js';

describe('SMS parser fixture corpus', () => {
  it.each(smsFixtures)('$provenance: $name', ({ sender, message, receivedAt, expected }) => {
    expect(parseSms(message, receivedAt, banks, sender, parsing)).toStrictEqual(expected);
  });

  it('tracks the parser release represented by the corpus', () => {
    expect(PARSER_REVISION).toBe(16);
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
        parsing,
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
        parsing,
      ),
    ).toMatchObject({ type: 'transaction', transaction: { transferCounterpartyAlias: '7404' } });
  });
});

describe('merchant text is not a notification marker', () => {
  it.each(['FOOTPRINT', 'ATMOSPHERE', 'Reversal Coffee', 'Login Lounge', 'Insufficient Cafe'])(
    'imports a purchase at %s as a debit',
    merchant => {
      expect(
        parseSms(
          `Purchase Card **1234 Amount SAR 25 at ${merchant} on 2026-08-22 10:05`,
          '2026-08-22T10:10:30Z',
          banks,
          'SAB',
          parsing,
        ),
      ).toMatchObject({
        type: 'transaction',
        transaction: { kind: 'purchase', amountCents: -2500, payee: merchant },
      });
    },
  );
  it.each(['OTP 1234 for purchase', 'Purchase declined due to insufficient funds'])(
    'still ignores a real %s notification mentioning a merchant',
    prefix => {
      expect(
        parseSms(
          `${prefix} at Reversal Coffee on 2026-08-22 10:05`,
          '2026-08-22T10:10:30Z',
          banks,
          'SAB',
          parsing,
        ).type,
      ).toBe('ignored');
    },
  );
});
