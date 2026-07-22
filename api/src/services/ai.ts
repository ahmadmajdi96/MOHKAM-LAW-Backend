import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env, features } from "../env.ts";
import { serviceUnavailable } from "../http/errors.ts";
import { logger } from "../observability/logger.ts";
import { aiRequestDuration, aiTokensTotal } from "../observability/metrics.ts";

/**
 * Novita (OpenAI-compatible) — carried over from the original
 * src/lib/ai-gateway.server.ts, with production concerns added: timeouts,
 * bounded retries, and latency/token metrics.
 */

export const aiProvider = createOpenAICompatible({
  name: "novita",
  baseURL: env.AI_GATEWAY_BASE_URL,
  apiKey: env.NOVITA_API_KEY,
});

export const chatModel = () => {
  if (!features.ai) {
    throw serviceUnavailable("ai_unconfigured", "AI is not configured on this server");
  }
  return aiProvider(env.AI_MODEL);
};

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

/**
 * Retries only what is actually retryable: network faults, 429, and 5xx.
 * A 400 from a malformed prompt is retried zero times — retrying it just
 * burns quota and latency to fail identically.
 */
export async function withAiRetry<T>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = performance.now();

    try {
      const result = await fn(controller.signal);
      aiRequestDuration.observe(
        { model: env.AI_MODEL, operation, status: "ok" },
        (performance.now() - startedAt) / 1000,
      );
      return result;
    } catch (error) {
      lastError = error;
      aiRequestDuration.observe(
        { model: env.AI_MODEL, operation, status: "error" },
        (performance.now() - startedAt) / 1000,
      );

      const status = (error as { statusCode?: number }).statusCode;
      const retryable =
        status === undefined || status === 429 || (status >= 500 && status < 600);

      if (!retryable || attempt === MAX_ATTEMPTS) break;

      // Exponential backoff with jitter, so a provider blip does not turn into
      // a synchronised retry stampede from every worker at once.
      const backoff = 2 ** attempt * 250 + Math.random() * 250;
      logger.warn(
        { operation, attempt, status, backoff },
        "ai request failed — retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    } finally {
      clearTimeout(timer);
    }
  }

  logger.error({ err: lastError, operation }, "ai request failed permanently");
  throw serviceUnavailable("ai_unavailable", "The AI service is temporarily unavailable");
}

export function recordTokenUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}) {
  if (usage.inputTokens) {
    aiTokensTotal.inc({ model: env.AI_MODEL, kind: "input" }, usage.inputTokens);
  }
  if (usage.outputTokens) {
    aiTokensTotal.inc({ model: env.AI_MODEL, kind: "output" }, usage.outputTokens);
  }
}

/**
 * Embeddings for RAG. Novita exposes the standard OpenAI embeddings shape, so
 * this is a plain fetch rather than a provider abstraction.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!features.ai) {
    throw serviceUnavailable("ai_unconfigured", "AI is not configured on this server");
  }

  return withAiRetry("embed", async (signal) => {
    const response = await fetch(`${env.AI_GATEWAY_BASE_URL}/embeddings`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.NOVITA_API_KEY}`,
      },
      body: JSON.stringify({ model: env.AI_EMBEDDING_MODEL, input: texts }),
    });

    if (!response.ok) {
      const error = new Error(`embeddings failed: ${response.status}`);
      (error as { statusCode?: number }).statusCode = response.status;
      throw error;
    }

    const payload = (await response.json()) as {
      data: { embedding: number[] }[];
      usage?: { prompt_tokens?: number };
    };

    if (payload.usage?.prompt_tokens) {
      aiTokensTotal.inc(
        { model: env.AI_EMBEDDING_MODEL, kind: "input" },
        payload.usage.prompt_tokens,
      );
    }

    return payload.data.map((item) => item.embedding);
  });
}
