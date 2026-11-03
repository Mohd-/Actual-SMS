import { banks } from './fixtures/banks.js';
import { describe, expect, it } from 'vitest';
import { normalizeText, PARSER_REVISION, parseSms } from '../src/parser.js';
import { smsFixtures } from './fixtures/sms.js';

describe('SMS parser fixture corpus', () => {
  it.each(smsFixtures)('$provenance: $name', ({ sender, message, receivedAt, expected }) => {
    expect(parseSms(message, receivedAt, banks, sender)).toStrictEqual(expected);
  });

  it('tracks the parser release represented by the corpus', () => {
    expect(PARSER_REVISION).toBe(14);
  });
});

describe('SMS normalization', () => {
  it('normalizes Arabic digits and separators', () => {
    expect(normalizeText('١٬٢٣٤٫٥٦')).toBe('1234.56');
  });
});
