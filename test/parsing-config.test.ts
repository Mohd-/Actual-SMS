import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { compileParserConfig, validateTemplateReferences } from '../src/parsing/config.js';
import { parseSms } from '../src/parser.js';
import { banks, parsing } from './fixtures/banks.js';
const document = () =>
  YAML.parse(readFileSync(new URL('../config/parsing.yaml', import.meta.url), 'utf8'));
const template = () => ({
  id: 'custom',
  match: [{ source: 'Special purchase', flags: 'i' }],
  kind: 'purchase',
  fields: { principal: [{ source: 'Paid (?<value>[\\d.]+)', flags: 'u' }] },
  required: ['principal'],
});
const bankList = () => banks.map(b => ({ ...b, templates: b.id === 'sab' ? ['custom'] : [] }));
const parse = (
  raw: string,
  config = compileParserConfig({ ...document(), templates: [template()] }),
  sender = 'SAB',
) => parseSms(raw, '2026-08-22T10:00:00Z', bankList(), sender, config);
describe('configurable message templates', () => {
  it('overrides extraction and inherits omitted fields', () => {
    expect(parse('Special purchase Paid 12.50 Card **1234 at Example')).toMatchObject({
      type: 'transaction',
      transaction: { amountCents: -1250, accountAlias: '1234', payee: 'Example' },
    });
  });
  it('uses shared rules when no template matches and isolates other banks', () => {
    const text = 'Purchase Card **1234 Amount: SAR 20 at Example';
    expect(parse(text)).toEqual(parseSms(text, '2026-08-22T10:00:00Z', banks, 'SAB', parsing));
    expect(parse('Special purchase Amount: SAR 20', undefined, 'D360')).toMatchObject({
      type: 'transaction',
      transaction: { amountCents: -2000 },
    });
  });
  it('does not fall back when an overridden required field fails', () => {
    expect(parse('Special purchase Amount: SAR 20')).toEqual({
      type: 'needs_review',
      reason: 'malformed_notification',
    });
  });
  it('does not fall back for an optional override either', () => {
    const t = template();
    t.required = [];
    expect(
      parse(
        'Special purchase Amount: SAR 20',
        compileParserConfig({ ...document(), templates: [t] }),
      ),
    ).toEqual({ type: 'needs_review', reason: 'malformed_notification' });
  });
  it('retains overlapping templates for review', () => {
    const config = compileParserConfig({
      ...document(),
      templates: [template(), { ...template(), id: 'other' }],
    });
    const list = bankList().map(b => ({ ...b, templates: ['custom', 'other'] }));
    expect(
      parseSms('Special purchase Paid 10', '2026-08-22T10:00:00Z', list, 'SAB', config),
    ).toEqual({ type: 'needs_review', reason: 'ambiguous_template' });
  });
  it('keeps ignored notifications ahead of templates', () => {
    expect(parse('OTP Special purchase Paid 10')).toEqual({
      type: 'ignored',
      reason: 'otp_or_login',
    });
  });
  it('has no mutable regex state between messages', () => {
    const config = compileParserConfig({ ...document(), templates: [template()] });
    const a = parse('Special purchase Paid 10', config);
    for (let i = 0; i < 10; i++) expect(parse('Special purchase Paid 10', config)).toEqual(a);
  });
  it('validates required dates and foreign amounts', () => {
    for (const field of ['date', 'foreign']) {
      const t = {
        ...template(),
        required: [field],
        fields: {
          [field]:
            field === 'date'
              ? [{ source: 'Date: (?<value>\\S+)' }]
              : [{ source: 'FX (?<currency>USD) (?<amount>\\S+)' }],
        },
      };
      expect(
        parse(
          'Special purchase Paid 10 Date: garbage FX USD invalid',
          compileParserConfig({ ...document(), templates: [t] }),
        ),
      ).toEqual({ type: 'needs_review', reason: 'malformed_notification' });
    }
  });
  it.each([
    [
      'version',
      (d: any) => {
        d.schemaVersion = 2;
      },
    ],
    [
      'unknown key',
      (d: any) => {
        d.extra = true;
      },
    ],
    [
      'unknown field',
      (d: any) => {
        d.templates[0].fields.typo = [];
      },
    ],
    [
      'unknown kind',
      (d: any) => {
        d.templates[0].kind = 'salary';
      },
    ],
    [
      'invalid regex',
      (d: any) => {
        d.templates[0].match[0].source = '(';
      },
    ],
    [
      'global flag',
      (d: any) => {
        d.templates[0].match[0].flags = 'g';
      },
    ],
    [
      'sticky flag',
      (d: any) => {
        d.templates[0].match[0].flags = 'y';
      },
    ],
    [
      'duplicate flags',
      (d: any) => {
        d.templates[0].match[0].flags = 'ii';
      },
    ],
    [
      'missing capture',
      (d: any) => {
        d.templates[0].fields.principal[0].source = 'Paid (\\d+)';
      },
    ],
    [
      'duplicate template',
      (d: any) => {
        d.templates.push(template());
      },
    ],
    [
      'required typo',
      (d: any) => {
        d.templates[0].required = ['typo'];
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const d = { ...document(), templates: [template()] };
    mutate(d);
    expect(() => compileParserConfig(d)).toThrow();
  });
  it('rejects unknown bank template references', () => {
    expect(() => validateTemplateReferences(bankList(), parsing)).toThrow(
      'unknown template custom',
    );
  });
});
