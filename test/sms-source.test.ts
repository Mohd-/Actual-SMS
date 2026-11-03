import { banks } from './fixtures/banks.js';
import { describe, expect, it } from 'vitest';
import { resolveSmsSource } from '../src/sms-source.js';

describe('SMS source resolution', () => {
  it.each([
    ['SAB', 'sab'],
    ['Saudi Awwal', 'sab'],
    ['AlrajhiBank', 'alrajhi'],
    ['الراجحي', 'alrajhi'],
    ['Wadaie', 'wadaie'],
    ['D360Bank', 'd360'],
    ['D360', 'd360'],
    ['D360 Bank', 'd360'],
  ])('identifies supported sender %s', (sender, bank) => {
    expect(resolveSmsSource(sender, 'message naming another bank', banks)).toEqual({
      type: 'supported',
      bank,
    });
  });

  it('treats a named sender as authoritative', () => {
    expect(resolveSmsSource('Other', 'SAB purchase', banks)).toEqual({
      type: 'unsupported',
      disposition: 'ignored',
    });
  });

  it('retains message-name detection only for the sender-optional contract', () => {
    expect(resolveSmsSource('', 'SAB purchase', banks)).toEqual({ type: 'supported', bank: 'sab' });
  });

  it('marks the known unsupported STC sender for review', () => {
    expect(resolveSmsSource('STC Bank', 'purchase', banks)).toEqual({
      type: 'unsupported',
      disposition: 'needs_review',
    });
  });
});
