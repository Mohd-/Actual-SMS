import { z } from 'zod';
import type { Enricher, EnrichmentResult } from './types.js';

export const OPENCODE_GO_CHAT_COMPLETIONS_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

const resultSchema = z.object({
  categoryId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(160),
});

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export class OpenCodeGoEnricher implements Enricher {
  constructor(
    private key: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 15_000,
  ) {}

  async enrich(input: Parameters<Enricher['enrich']>[0]): Promise<EnrichmentResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const response = await this.fetchImpl(OPENCODE_GO_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Select the most likely category ID for this payee from the supplied categories. Return only JSON with categoryId, confidence, and reason.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                payee: input.payee,
                categories: input.categories,
              }),
            },
          ],
        }),
      });
      if (!response.ok) {
        return {
          status: 'http_error',
          model: this.model,
          durationMs: Date.now() - started,
          httpStatus: response.status,
          response: (await response.text()).slice(0, 65_536),
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          status: 'invalid_response',
          model: this.model,
          durationMs: Date.now() - started,
          httpStatus: response.status,
          error: 'Provider response was not JSON',
        };
      }
      const completion = responseSchema.safeParse(body);
      if (!completion.success)
        return {
          status: 'invalid_response',
          model: this.model,
          durationMs: Date.now() - started,
          httpStatus: response.status,
          response: body,
          error: completion.error.message,
        };
      let parsed: unknown;
      try {
        parsed = JSON.parse(completion.data.choices[0]!.message.content);
      } catch {
        return {
          status: 'invalid_response',
          model: this.model,
          durationMs: Date.now() - started,
          httpStatus: response.status,
          response: body,
          error: 'Completion content was not JSON',
        };
      }
      const result = resultSchema.safeParse(parsed);
      if (!result.success || !input.categories.some(c => c.id === result.data.categoryId)) {
        return {
          status: 'invalid_response',
          model: this.model,
          durationMs: Date.now() - started,
          httpStatus: response.status,
          response: body,
          error: result.success ? 'Unknown category ID' : result.error.message,
        };
      }
      return {
        status: 'success',
        suggestion: result.data,
        model: this.model,
        durationMs: Date.now() - started,
        httpStatus: response.status,
        response: body,
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return {
        status: aborted ? 'timeout' : 'network_error',
        model: this.model,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export class PayeeSuggestions {
  private readonly recent = new Map<
    string,
    { expires: number; promise: Promise<import('./types.js').AiSuggestion | null> }
  >();

  constructor(
    private readonly provider: Enricher,
    private readonly minConfidence: number,
  ) {}

  suggest(payee: string, categories: Parameters<Enricher['enrich']>[0]['categories']) {
    if (!categories.length) return Promise.resolve(null);
    const key = JSON.stringify([payee, categories]);
    const existing = this.recent.get(key);
    const now = Date.now();
    if (existing && existing.expires > now) return existing.promise;
    for (const [id, entry] of this.recent) if (entry.expires <= now) this.recent.delete(id);
    if (this.recent.size >= 128) return Promise.resolve(null);
    const promise = this.provider
      .enrich({ payee, categories })
      .then(result =>
        result.status === 'success' &&
        result.suggestion.confidence >= this.minConfidence &&
        categories.some(category => category.id === result.suggestion.categoryId)
          ? result.suggestion
          : null,
      )
      .catch(() => null)
      .then(suggestion => {
        if (!suggestion && this.recent.get(key)?.promise === promise) this.recent.delete(key);
        return suggestion;
      });
    this.recent.set(key, { expires: now + 5 * 60_000, promise });
    return promise;
  }
}
