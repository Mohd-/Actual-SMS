import { describe, expect, it, vi } from 'vitest';
import { OpenCodeGoEnricher, OPENCODE_GO_CHAT_COMPLETIONS_URL } from '../src/enricher.js';

const input = {
  merchant: 'SAMPLE BOOKS',
  location: { latitude: 24.7136, longitude: 46.6753 },
  occurredAt: '2026-08-22T10:05:00+03:00',
  categories: [{ id: 'cat-shopping', name: 'Shopping' }],
};

function completion(content: unknown, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

describe('OpenCode Go enricher', () => {
  it('calls Chat Completions in JSON mode and accepts an eligible category', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      completion({
        payee: 'Sample Books',
        categoryId: 'cat-shopping',
        confidence: 0.96,
        reason: 'Known retailer',
      }),
    );
    const result = await new OpenCodeGoEnricher('secret-key', 'deepseek-v4-flash', request).enrich(
      input,
    );

    expect(result).toMatchObject({
      status: 'success',
      suggestion: { payee: 'Sample Books', categoryId: 'cat-shopping' },
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(OPENCODE_GO_CHAT_COMPLETIONS_URL);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-key' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      response_format: { type: 'json_object' },
    });
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    [
      'invalid schema',
      completion({
        payee: 'Example Store',
        categoryId: 'cat-shopping',
        confidence: 2,
        reason: 'x',
      }),
    ],
    [
      'unknown category',
      completion({ payee: 'Example Store', categoryId: 'unknown', confidence: 0.9, reason: 'x' }),
    ],
    ['rate limit', completion({}, 429)],
    ['exhausted Go limit', completion({}, 402)],
    ['provider failure', completion({}, 500)],
  ])('records a failed result for %s', async (_name, response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await new OpenCodeGoEnricher('key', 'deepseek-v4-flash', request).enrich(input);
    expect(result.status).not.toBe('success');
  });

  it('times out without throwing', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    await expect(
      new OpenCodeGoEnricher('key', 'deepseek-v4-flash', request, 5).enrich(input),
    ).resolves.toMatchObject({ status: 'timeout' });
  });

  it('sends only the approved enrichment fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      completion({
        payee: 'Example Store',
        categoryId: 'cat-shopping',
        confidence: 0.9,
        reason: 'x',
      }),
    );
    await new OpenCodeGoEnricher('key', 'deepseek-v4-flash', request).enrich(input);
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    const outbound = JSON.parse(body.messages[1].content);

    expect(Object.keys(outbound).sort()).toEqual([
      'categories',
      'location',
      'merchant',
      'occurredAt',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/raw|sms|balance|alias|account|personal/i);
  });
});

const live = process.env.LIVE_OPENCODE_GO_TEST === '1' && process.env.OPENCODE_GO_API_KEY;
describe.skipIf(!live)('OpenCode Go live smoke test', () => {
  it('returns a valid suggestion', async () => {
    const result = await new OpenCodeGoEnricher(
      process.env.OPENCODE_GO_API_KEY!,
      process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4-flash',
    ).enrich(input);
    expect(result.status).toBe('success');
  }, 30_000);
});
