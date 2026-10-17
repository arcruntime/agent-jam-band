import { config } from './config.js';
import { getClient, reasoningParams } from './llm.js';

async function main() {
  const model = config.model;
  console.log(`Pinging ${model} at ${config.baseURL} (reasoning_effort=${config.reasoningEffort ?? 'off'}) ...`);

  const started = Date.now();
  const res = await getClient().chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with the word ready' }],
    ...reasoningParams(),
  });
  const ms = Date.now() - started;

  const msg = res.choices[0]?.message as { content?: string | null; reasoning_content?: string } | undefined;
  console.log(`\nReply: ${msg?.content?.trim() || '(empty)'}`);
  if (msg?.reasoning_content) {
    console.log(`(model also returned reasoning_content, ${msg.reasoning_content.length} chars)`);
  }

  const u = res.usage;
  console.log('\nToken usage:');
  console.log(`  prompt:     ${u?.prompt_tokens ?? 'n/a'}`);
  console.log(`  completion: ${u?.completion_tokens ?? 'n/a'}`);
  console.log(`  total:      ${u?.total_tokens ?? 'n/a'}`);
  console.log(`\nResponding model: ${res.model} | finish: ${res.choices[0]?.finish_reason} | ${ms} ms`);
}

main().catch((err) => {
  const e = err as { status?: number; message?: string };
  console.error(`Ping failed${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message}`);
  process.exit(1);
});
