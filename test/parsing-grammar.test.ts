import { describe, expect, it } from 'vitest';
import {
  extractDate,
  extractBiller,
  extractLabelledValue,
  extractNumericReference,
} from '../src/parsing/extractors.js';
import { fieldLabels, transactionKindRules } from '../src/parsing/grammar.js';

describe('shared SMS grammar', () => {
  it('keeps transaction markers in semantic precedence order', () => {
    expect(transactionKindRules.map(rule => rule.value)).toEqual([
      'card_payment',
      'transfer_in',
      'transfer_out',
      'withdrawal',
      'refund',
      'purchase',
    ]);
  });

  it.each([
    ['card_payment', 'سداد بطاقة'],
    ['card_payment', 'سداد فاتورة مفوتر: 404 بطاقة ائتمانية'],
    ['transfer_in', 'تحويل ائتماني محلي'],
    ['transfer_in', 'حوالة راتب'],
    ['transfer_out', 'Funds Transfer Accepted'],
    ['withdrawal', 'سحب نقدي'],
    ['refund', 'reversal'],
    ['purchase', 'مشتريات'],
    ['purchase', 'مدفوعات وزارة الداخلية'],
    ['purchase', 'سداد فاتورة مفوتر: 202 شركة تجريبية'],
  ])('recognizes %s markers independently of a bank', (kind, text) => {
    const match = transactionKindRules.find(rule =>
      rule.patterns.some(pattern => pattern.test(text)),
    );
    expect(match?.value).toBe(kind);
  });

  it('extracts labelled transfer fields independently of their order', () => {
    const text =
      'Amount: SAR 100 IBAN: SA0000000000006303 Beneficiary: Example Person To: SampleLedger2 From: 5202';
    expect(extractLabelledValue(text, fieldLabels.from)).toBe('5202');
    expect(extractLabelledValue(text, fieldLabels.to)).toBe('SampleLedger2');
    expect(extractNumericReference(extractLabelledValue(text, fieldLabels.iban))).toBe('6303');
    expect(extractLabelledValue(text, fieldLabels.beneficiary)).toBe('Example Person');
  });

  it('keeps a bill source bounded and extracts its biller', () => {
    const text =
      'سداد فاتورة من: ***202 مفوتر: 404 بنك الراجحي البطاقة الائتمانية لخدمة: POSTPAID رقم الفاتورة: 111817823 مبلغ: 9145 SAR';
    expect(extractLabelledValue(text, fieldLabels.from)).toBe('***202');
    expect(extractBiller(text)).toEqual({
      identifier: '404',
      name: 'بنك الراجحي البطاقة الائتمانية',
    });
  });

  it('does not treat POSTPAID as a POS purchase marker', () => {
    const purchase = transactionKindRules.find(rule =>
      rule.patterns.some(pattern => pattern.test('POSTPAID')),
    );
    expect(purchase).toBeUndefined();
  });

  it.each(['26/8/22', '22/8/26', '22/8/2026'])(
    'resolves ambiguous slash date %s without bank-specific input',
    value => {
      expect(extractDate(value, '2026-08-23T12:00:00+03:00')).toContain('2026-08-22');
    },
  );
});
