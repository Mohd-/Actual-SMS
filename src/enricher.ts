import { z } from 'zod';
import type { Enricher, EnrichmentResult } from './types.js';

export const OPENCODE_GO_CHAT_COMPLETIONS_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

const resultSchema = z.object({
  payee: z.string().min(1).max(100),
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
                'Normalize the merchant and select exactly one category ID from the supplied categories. Use location and transaction time only to disambiguate. Return only JSON with payee, categoryId, confidence, and reason.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                merchant: input.merchant,
                location: input.location,
                occurredAt: input.occurredAt,
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
export class NoopEnricher implements Enricher {
  async enrich(): Promise<EnrichmentResult> {
    return { status: 'disabled', durationMs: 0 };
  }
}
