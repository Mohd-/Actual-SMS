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
    // A statement-style "Credit card: Payment" notification reports money
    // received by the card account, unlike an instruction to pay a card bill.
    value: 'transfer_in',
    patterns: [/\bcredit\s+card\s*[:-]\s*(?:payment|credited)\b/iu],
  },
  {
    value: 'refund',
    patterns: [/\bcashback\s+of\b/iu],
  },
  {
    value: 'card_payment',
    patterns: [
      /(?:credit card.*(?:payment|transfer)|card payment|بطاقة\s+[إائ]ئ?تمانية\s*[:：]\s*تسديد|سداد بطاقة|تحويل.*بطاقة ائتمانية|سداد\s+فاتورة(?=[\s\S]*?بطاق[ةه]\s+\S*ئتماني))/iu,
    ],
  },
  {
    value: 'transfer_in',
    patterns: [
      /(?:incoming transfer|transfer received|local credit transfer|reverse(?:d)? transfer|(?:sarie\s*)?(?:transfer\s*)?(?:credited|credit(?!\s+card\b))|(?:has\s+been\s+)?deposited(?:\s+into)?|حوالة واردة|حوالة راتب|تحويل وارد|تحويل ائتماني(?: محلي)?|حوالة ائتمانية|تم إيداع|حوالة.*(?:مضافة|معكوسة)|تحويل.*(?:مضاف|معكوس))/iu,
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
    patterns: [/(?:refund|reverse transaction|reversal|reversed|استرداد|عكس عملية)/iu],
  },
  {
    value: 'purchase',
    patterns: [
      /(?:purchase|\bpos\b|online|e-?commerce|شراء|مشتريات|مدفوعات وزارة الداخلية|سداد\s+فاتورة)/iu,
    ],
  },
];

export const accountAliasPatterns = [
  /بطاقة\s+(?:الأول\s+)?مدى-?أثير\s*\(([\d٠-٩]{3,6})\)/iu,
  /(?:account|acct|a\/c|حساب|الحساب|بطاقة|card|by)[^\d٠-٩]{0,12}(?:[*xX-]*)([\d٠-٩]{3,6})/iu,
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
  total: [
    'total due amount',
    'total amount in (?:SAR|SR)',
    'total amount',
    'المبلغ الإجمالي',
    'اجمالي المبلغ',
  ],
  principal: [
    'amount in (?:SAR|SR)',
    'amount',
    'credited with',
    'cashback of',
    'purchase amount',
    'transfer amount',
    'مبلغ العملية',
    'المبلغ',
    'بمبلغ',
    'مبلغ',
  ],
  fee: [
    'international fees in (?:SAR|SR)',
    'fees?\\s*(?:&|and)\\s*vat',
    'fees?',
    'fee',
    'الرسوم\\s*(?:و|and)\\s*الضريبة',
    'رسوم',
  ],
  balance: ['available balance', 'current balance', 'balance', 'الرصيد المتاح', 'الرصيد'],
} as const;

export const fieldDelimiter = '[:：,،;؛-]';
export const dateValue =
  '(?:20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}/\\d{1,2}/\\d{2,4}(?:\\s+\\d{1,2}:\\d{2})?)';
export const labelledFieldStops =
  '(?:from|to|iban|beneficiary(?:\\s+name)?|biller|account|amount|purchase\\s+amount|transfer\\s+amount|fees?(?:\\s*(?:&|and)\\s*vat)?|balance|date|on|at|من|إلى|الى|آيبان|ايبان|رقم\\s*(?:ال)?ايبان|المستفيد(?:\\s*الاسم)?|مفوتر|لخدمة|الخدمة|رقم\\s*الفاتورة|الحساب|مبلغ(?:\\s*العملية)?|المبلغ|رسوم|الرصيد|بتاريخ|في)';

export const isoDatePattern = /(20\d\d[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/;
export const slashDatePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2})?)/;
export const foreignCurrency = '(?:USD|EUR|GBP|AED|KWD|BHD|QAR|JPY)';
export const foreignAmountPattern = new RegExp(
  `${foreignCurrency}\\s*([\\d,.]+)|([\\d,.]+)\\s*(${foreignCurrency})`,
  'i',
);
export const merchantPatterns = [
  /(?:merchant|\bat\b|entity|لدى|متجر|الجهة)\s*[:：]?\s*([^,;]+?)(?=\s+(?:on|date|total\s+amount|amount|SAR|SR|for\s+(?:SAR|SR)|(?:available|current)\s+balance|balance|country|fees?\b|رصيد|في|بتاريخ|المبلغ|الرصيد(?:\s+المتاح)?|service|الخدمة)|$)/iu,
] as const;
