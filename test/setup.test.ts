import { describe, expect, it } from 'vitest';
import {
  encodeEnvValue,
  parseChoice,
  parseChoices,
  renderEnv,
  verifyActualServer,
} from '../src/setup.js';

const choices = [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }];

describe('setup helpers', () => {
  it('quotes dotenv values when necessary', () => {
    expect(encodeEnvValue('simple-value')).toBe('simple-value');
    expect(encodeEnvValue('space and "quote"')).toBe('"space and \\"quote\\""');
    expect(renderEnv({ SECRET: 'line\nbreak' })).toBe('SECRET="line\\nbreak"\n');
  });

  it('parses single and multiple numbered choices', () => {
    expect(parseChoice('2', choices).name).toBe('Two');
    expect(parseChoices('3, 1, 3', choices).map(choice => choice.name)).toEqual(['Three', 'One']);
    expect(() => parseChoice('0', choices)).toThrow('1 to 3');
    expect(() => parseChoices('1,4', choices)).toThrow('1 to 3');
  });

  it('preflights the Actual sync endpoint and exposes HTTP errors', async () => {
    const ok = async () =>
      new Response(JSON.stringify({ build: { version: '26.5.2' } }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(verifyActualServer('http://actual.test:5006/', ok)).resolves.toBe('26.5.2');
    await expect(
      verifyActualServer('https://actual.test', async () => new Response('', { status: 404 })),
    ).rejects.toThrow('HTTP 404');
  });
});
