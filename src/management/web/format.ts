import type { EventStatus, TxKind } from '../../types.js';

export type Tone = 'positive' | 'warning' | 'danger' | 'neutral' | 'accent';
export interface StatusMeta {
  label: string;
  tone: Tone;
  description: string;
}
export const statusMeta: Record<EventStatus, StatusMeta> = {
  queued: { label: 'Queued', tone: 'neutral', description: 'Waiting to be processed' },
  processing: { label: 'Processing', tone: 'accent', description: 'Currently being imported' },
  imported: { label: 'Imported', tone: 'positive', description: 'Written to Actual' },
  imported_review: {
    label: 'Imported, review',
    tone: 'warning',
    description: 'Written to Actual with a review flag',
  },
  needs_review: {
    label: 'Needs review',
    tone: 'warning',
    description: 'Recognized but not safe to import automatically',
  },
  ignored: { label: 'Ignored', tone: 'neutral', description: 'Not a financial transaction' },
  failed: { label: 'Failed', tone: 'danger', description: 'Import could not complete' },
};

export const statusOrder: EventStatus[] = [
  'queued',
  'processing',
  'imported',
  'imported_review',
  'needs_review',
  'ignored',
  'failed',
];

export const reasonLabels: Record<string, string> = {
  otp_or_login: 'One-time code or login alert',
  declined_or_insufficient_funds: 'Declined or insufficient funds',
  duplicate_fee_notification: 'Duplicate fee notification',
  unsupported_sender: 'Unsupported sender',
  unrecognized_template: 'Unrecognized message',
  malformed_notification: 'Malformed notification',
  ambiguous_template: 'Ambiguous template match',
};

export const kindLabels: Record<TxKind, string> = {
  purchase: 'Purchase',
  refund: 'Refund',
  withdrawal: 'Withdrawal',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  card_payment: 'Card payment',
};

export function statusLabel(value: string) {
  return statusMeta[value as EventStatus]?.label ?? value;
}
export function statusTone(value: string): Tone {
  return statusMeta[value as EventStatus]?.tone ?? 'neutral';
}
export function reasonLabel(value: string | null | undefined) {
  if (!value) return '';
  return reasonLabels[value] ?? value.replaceAll('_', ' ');
}
export function kindLabel(value: string) {
  return kindLabels[value as TxKind] ?? value.replaceAll('_', ' ');
}

export function formatDateTime(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
export function formatExact(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
export function formatUtc(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}
export function formatRelative(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return formatter.format(seconds, 'second');
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86400), 'day');
}
export function formatAmount(cents: number | null | undefined) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'SAR',
    currencyDisplay: 'code',
  }).format(cents / 100);
}
export function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : new Intl.NumberFormat().format(value);
}
export function shortId(value: string, length = 10) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
export function dateInputValue(value: Date | number = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function startOfLocalDay(value: string) {
  return new Date(`${value}T00:00:00`).toISOString();
}
export function endOfLocalDay(value: string) {
  return new Date(`${value}T23:59:59.999`).toISOString();
}
export function categoryDisplayName(
  category: { id: string; name: string; groupName?: string },
  all: { id: string; name: string; groupName?: string }[],
) {
  const ambiguous = all.some(item => item.id !== category.id && item.name === category.name);
  return ambiguous && category.groupName
    ? `${category.groupName} / ${category.name}`
    : category.name;
}
export function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
