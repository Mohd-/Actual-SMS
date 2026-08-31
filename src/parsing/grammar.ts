import type { TxKind } from '../types.js';

export interface PatternRule<T> {
  value: T;
  patterns: readonly RegExp[];
}

export const ignoredNotificationRules: readonly PatternRule<
  'otp_or_login' | 'declined_or_insufficient_funds' | 'duplicate_fee_notification'
>[] = [
  {
    value: 'otp_or_login',
    patterns: [/(otp|one.?time|verification code|رمز (?:التحقق|التوثيق)|كلمة المرور|login)/iu],
  },
  {
    value: 'declined_or_insufficient_funds',
    patterns: [/(insufficient|declined.*fund|رصيد (?:غير كاف|لا يكفي)|لعدم كفاية)/iu],
  },
  {
    value: 'duplicate_fee_notification',
    patterns: [/تم خصم دفعة من حسابك/iu],
  },
];

// Order is semantic: more specific transfer/card forms must win over words
// such as "purchase" or "reversal" that can occur elsewhere in a message.
export const transactionKindRules: readonly PatternRule<TxKind>[] = [
  {
    value: 'card_payment',
    patterns: [
      /(?:credit card.*(?:payment|transfer)|card payment|سداد بطاقة|تحويل.*بطاقة ائتمانية|سداد\s+فاتورة(?=[\s\S]*?بطاق[ةه]\s+\S*ئتماني))/iu,
    ],
  },
  {
    value: 'transfer_in',
    patterns: [
      /(?:incoming transfer|transfer received|local credit transfer|reverse(?:d)? transfer|(?:sarie\s*)?(?:transfer\s*)?(?:credited|credit)|حوالة واردة|حوالة راتب|تحويل وارد|تحويل ائتماني(?: محلي)?|حوالة ائتمانية|تم إيداع|حوالة.*(?:مضافة|معكوسة)|تحويل.*(?:مضاف|معكوس))/iu,
    ],
  },
  {
    value: 'transfer_out',
    patterns: [
      /(?:outgoing transfer|transfer sent|funds? transfer\s+accepted|transfer\s+accepted|accepted.*sarie|sarie.*accepted|حوالة صادرة|تحويل صادر|تم تحويل|تم قبول.*(?:حوالة|تحويل))/iu,
    ],
  },
  {
    value: 'withdrawal',
    patterns: [/(?:atm|cash withdrawal|سحب نقدي|صراف)/iu],
  },
  {
    value: 'refund',
    patterns: [/(?:refund|reversal|reversed|استرداد|عكس عملية)/iu],
  },
  {
    value: 'purchase',
    patterns: [
      /(?:purchase|\bpos\b|online|e-?commerce|شراء|مشتريات|مدفوعات وزارة الداخلية|سداد\s+فاتورة)/iu,
    ],
  },
];

export const accountAliasPatterns = [
  /(?:account|acct|a\/c|حساب|الحساب|بطاقة|card)[^\d٠-٩]{0,12}(?:[*xX-]*)([\d٠-٩]{3,6})/iu,
  /(?:[*xX]){2,}([\d٠-٩]{3,6})/u,
] as const;

export const allAccountAliasesPattern =
  /(?:account|acct|a\/c|حساب|الحساب|بطاقة|card)[^\d٠-٩]{0,12}(?:[*xX-]*)([\d٠-٩]{3,6})/giu;

export const fieldLabels = {
  from: '(?:from|من)',
  to: '(?:to|إلى|الى)',
  iban: '(?:iban|آيبان|ايبان|رقم\\s*(?:ال)?ايبان)',
  beneficiary: '(?:beneficiary(?:\\s+name)?|المستفيد(?:\\s*الاسم)?)',
  biller: '(?:biller|مفوتر)',
} as const;

export const amountLabels = {
  total: ['total due amount', 'total amount', 'المبلغ الإجمالي', 'اجمالي المبلغ'],
  principal: ['amount', 'purchase amount', 'transfer amount', 'مبلغ العملية', 'المبلغ', 'مبلغ'],
  fee: ['fees?\\s*(?:&|and)\\s*vat', 'fees?', 'fee', 'الرسوم\\s*(?:و|and)\\s*الضريبة', 'رسوم'],
  balance: ['available balance', 'current balance', 'balance', 'الرصيد المتاح', 'الرصيد'],
} as const;

export const fieldDelimiter = '[:：,،;؛-]';
export const dateValue =
  '(?:20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}/\\d{1,2}/\\d{2,4}(?:\\s+\\d{1,2}:\\d{2})?)';
export const labelledFieldStops =
  '(?:from|to|iban|beneficiary(?:\\s+name)?|biller|account|amount|purchase\\s+amount|transfer\\s+amount|fees?(?:\\s*(?:&|and)\\s*vat)?|balance|date|on|at|من|إلى|الى|آيبان|ايبان|رقم\\s*(?:ال)?ايبان|المستفيد(?:\\s*الاسم)?|مفوتر|لخدمة|الخدمة|رقم\\s*الفاتورة|الحساب|مبلغ(?:\\s*العملية)?|المبلغ|رسوم|الرصيد|بتاريخ|في)';

export const isoDatePattern = /(20\d\d[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/;
export const slashDatePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2})?)/;
export const foreignAmountPattern =
  /(?:USD|EUR|GBP|AED|KWD|BHD|QAR)\s*([\d,.]+)|([\d,.]+)\s*(USD|EUR|GBP|AED|KWD|BHD|QAR)/i;
export const merchantPatterns = [
  /(?:merchant|\bat\b|entity|لدى|متجر|الجهة)\s*[:：]?\s*([^,;]+?)(?=\s+(?:on|date|amount|SAR|SR|(?:available|current)\s+balance|balance|في|بتاريخ|المبلغ|الرصيد(?:\s+المتاح)?|service|الخدمة)|$)/iu,
] as const;
