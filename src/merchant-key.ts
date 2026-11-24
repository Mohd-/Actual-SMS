const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

export function merchantKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[٠-٩]/gu, digit => String(arabicDigits.indexOf(digit)))
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
