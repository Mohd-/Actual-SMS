import { describe, expect, it } from 'vitest';
import { resolveSmsSource } from '../src/sms-source.js';

describe('SMS source resolution', () => {
  it.each([
    ['SAB', 'sab'],
    ['Saudi Awwal', 'sab'],
    ['AlrajhiBank', 'alrajhi'],
    ['الراجحي', 'alrajhi'],
  ])('identifies supported sender %s', (sender, bank) => {
    expect(resolveSmsSource(sender, 'message naming another bank')).toEqual({
      type: 'supported',
      bank,
    });
  });

  it('treats a named sender as authoritative', () => {
    expect(resolveSmsSource('Other', 'SAB purchase')).toEqual({
      type: 'unsupported',
      disposition: 'ignored',
    });
  });

  it('retains message-name detection only for the sender-optional contract', () => {
    expect(resolveSmsSource('', 'SAB purchase')).toEqual({ type: 'supported', bank: 'sab' });
  });

  it('marks the known unsupported STC sender for review', () => {
    expect(resolveSmsSource('STC Bank', 'purchase')).toEqual({
      type: 'unsupported',
      disposition: 'needs_review',
    });
  });
});
