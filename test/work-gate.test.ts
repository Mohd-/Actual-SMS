import { describe, expect, it } from 'vitest';
import { WorkGate } from '../src/work-gate.js';

describe('runtime work coordination', () => {
  it('blocks new work and drains existing work before exclusive changes', async () => {
    const gate = new WorkGate();
    const release = gate.enter()!;
    let changed = false;
    const change = gate.change(async () => {
      changed = true;
    });
    expect(gate.enter()).toBeUndefined();
    await Promise.resolve();
    expect(changed).toBe(false);
    await expect(gate.change(async () => {})).rejects.toThrow('in progress');
    release();
    await change;
    expect(changed).toBe(true);
    expect(gate.enter()).toBeTypeOf('function');
  });
});
