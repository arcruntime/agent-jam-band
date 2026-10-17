import OpenAI from 'openai';
import { config } from './config.js';

let client: OpenAI | undefined;

/** OpenAI-compatible client pointed at AIAND_BASE_URL. Created lazily so missing env vars give a clear error. */
export function getClient(): OpenAI {
  client ??= new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  return client;
}

type Effort = NonNullable<OpenAI.Chat.ChatCompletionCreateParams['reasoning_effort']>;

/**
 * Spread into every chat.completions.create call: `{ reasoning_effort: "low" }` unless AIAND_REASONING_EFFORT says otherwise.
 * Pass `pinned` to force one agent to a fixed effort; AIAND_REASONING_EFFORT=off still omits the parameter for providers that reject it.
 */
export function reasoningParams(pinned?: string): { reasoning_effort?: Effort } {
  const configured = config.reasoningEffort;
  if (configured === null) return {};
  return { reasoning_effort: (pinned ?? configured) as Effort };
}
