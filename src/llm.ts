// Crusoe client (OpenAI-compatible). Temporal owns retries: maxRetries 0 here, and errors are
// classified into retryable (429/5xx/timeouts/schema/length) vs non-retryable (400/401/403/404).
import OpenAI, { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { ApplicationFailure } from '@temporalio/common';
import type { ZodType } from 'zod';
import type { Usage } from './schemas';
import { useFakeModel } from './env';
import { fakeChatJson } from './fake';

export const CRUSOE_BASE_URL = 'https://api.inference.crusoecloud.com/v1';

export interface ChatJsonRequest {
  model: string;
  /** Stable content first (brief + frozen glossary) for prefix caching. */
  system: string;
  /** Changing content last (chapter text). */
  user: string;
  schemaName: string;
  maxTokens?: number;
  seed?: number;
  temperature?: number;
  /** Nemotron models think by default; translator runs with thinking off. */
  enableThinking?: boolean;
  /** Extra provider-specific body fields (e.g. reasoning_effort). Merged last. */
  extra?: Record<string, unknown>;
  /** Extra chat_template_kwargs (e.g. Nemotron low_effort). */
  templateKwargs?: Record<string, unknown>;
}

export interface ChatJsonRaw {
  content: string;
  finishReason: string | null;
  usage: Usage;
}

export interface ChatJsonResult<T> extends ChatJsonRaw {
  data: T;
}

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: CRUSOE_BASE_URL,
      apiKey: process.env.CRUSOE_API_KEY,
      maxRetries: 0,
      timeout: Number(process.env.LLM_TIMEOUT_MS ?? 180_000),
    });
  }
  return client;
}

/** Each family names its thinking switch differently; both go in chat_template_kwargs. */
export function thinkingKwargs(model: string, enabled: boolean): Record<string, boolean> {
  if (model.toLowerCase().startsWith('deepseek-ai/')) return { thinking: enabled };
  return { enable_thinking: enabled }; // Nemotron 3 Super / 3.5 Lightning
}

const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

function classify(err: unknown): never {
  if (err instanceof ApplicationFailure) throw err;
  if (err instanceof APIConnectionTimeoutError || err instanceof APIConnectionError) {
    throw ApplicationFailure.create({ type: 'LLMConnection', message: err.message, nonRetryable: false, cause: err });
  }
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    const msg = `Crusoe ${status}: ${err.message}`;
    if (NON_RETRYABLE_STATUS.has(status)) {
      throw ApplicationFailure.create({ type: 'LLMNonRetryable', message: msg, nonRetryable: true, cause: err });
    }
    throw ApplicationFailure.create({ type: 'LLMRetryable', message: msg, nonRetryable: false, cause: err });
  }
  throw ApplicationFailure.create({
    type: 'LLMUnknown',
    message: err instanceof Error ? err.message : String(err),
    nonRetryable: false,
  });
}

async function realChatJson(req: ChatJsonRequest, schema: ZodType<unknown>): Promise<ChatJsonRaw> {
  const body = {
    model: req.model,
    messages: [
      { role: 'system' as const, content: req.system },
      { role: 'user' as const, content: req.user },
    ],
    response_format: zodResponseFormat(schema, req.schemaName),
    max_tokens: Math.max(1024, req.maxTokens ?? 1024),
    temperature: req.temperature ?? 0.2,
    seed: req.seed,
    // Non-standard but supported by Crusoe (listed in /v1/models supported_parameters).
    chat_template_kwargs: { ...thinkingKwargs(req.model, req.enableThinking ?? false), ...(req.templateKwargs ?? {}) },
    ...(req.extra ?? {}),
  };
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  let headers: Headers | undefined;
  try {
    const res = await getClient()
      .chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming)
      .withResponse();
    completion = res.data;
    headers = res.response.headers;
  } catch (err) {
    classify(err);
  }
  const choice = completion!.choices?.[0];
  const content = choice?.message?.content ?? '';
  const finishReason = choice?.finish_reason ?? null;
  const u = completion!.usage;
  const usage: Usage = {
    model: req.model,
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
    cached_tokens: u?.prompt_tokens_details ? (u.prompt_tokens_details.cached_tokens ?? 0) : null,
    created_cache_tokens: (u?.prompt_tokens_details as { created_cache_tokens?: number | null } | undefined)?.created_cache_tokens ?? null,
    reasoning_tokens: u?.completion_tokens_details?.reasoning_tokens ?? null,
  };
  console.log(
    `[llm] ${req.model} ${req.schemaName} finish=${finishReason} prompt=${usage.prompt_tokens} cached=${usage.cached_tokens ?? 'n/a'} ` +
      `created_cache=${usage.created_cache_tokens ?? 'n/a'} completion=${usage.completion_tokens} reasoning=${usage.reasoning_tokens ?? 'n/a'} rl_remaining_req=${headers?.get('x-ratelimit-remaining-requests') ?? '?'} ` +
      `rl_remaining_tok=${headers?.get('x-ratelimit-remaining-tokens') ?? '?'}`,
  );
  if (finishReason === 'length') {
    throw ApplicationFailure.create({ type: 'LLMTruncated', message: 'finish_reason=length (raise max_tokens or split input)', nonRetryable: false });
  }
  if (!content.trim()) {
    throw ApplicationFailure.create({ type: 'LLMEmpty', message: 'empty content from model', nonRetryable: false });
  }
  return { content, finishReason, usage };
}

/** One structured-output chat call, validated with Zod. Throws Temporal ApplicationFailures. */
export async function chatJson<T>(req: ChatJsonRequest, schema: ZodType<T>): Promise<ChatJsonResult<T>> {
  const raw = useFakeModel() ? await fakeChatJson(req) : await realChatJson(req, schema);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.content);
  } catch (e) {
    throw ApplicationFailure.create({ type: 'LLMBadJson', message: `model returned non-JSON: ${(e as Error).message}`, nonRetryable: false });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw ApplicationFailure.create({ type: 'LLMSchema', message: `schema ${req.schemaName} failed: ${result.error.message.slice(0, 500)}`, nonRetryable: false });
  }
  return { ...raw, data: result.data };
}
