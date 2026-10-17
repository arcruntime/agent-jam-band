import OpenAI from 'openai';
import { config } from './config.js';

let client: OpenAI | undefined;

/** OpenAI-compatible client pointed at AIAND_BASE_URL. Created lazily so missing env vars give a clear error. */
export function getClient(): OpenAI {
  client ??= new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  return client;
}

type Effort = NonNullable<OpenAI.Chat.ChatCompletionCreateParams['reasoning_effort']>;

/** Spread into every chat.completions.create call: `{ reasoning_effort: "low" }` unless AIAND_REASONING_EFFORT says otherwise. */
export function reasoningParams(): { reasoning_effort?: Effort } {
  const effort = config.reasoningEffort;
  return effort ? { reasoning_effort: effort as Effort } : {};
}
