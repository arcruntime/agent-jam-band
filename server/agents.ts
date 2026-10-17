import type OpenAI from 'openai';
import type { z } from 'zod';
import type { AgentReply, BassBar, DrumBar, JamState } from '../shared/types.js';
import { config } from './config.js';
import { getClient, reasoningParams } from './llm.js';
import { bassReplySchema, drumsReplySchema } from './schemas.js';

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

export class AgentError extends Error {}

const CONTEXT_BARS = 8;

const GRID = `Grid: 4/4 time, 16 steps per bar, each step is a 16th note. Step 0 is beat 1, and steps 0, 4, 8 and 12 are the four quarter-note beats. Each turn you write the NEXT 4 BARS, continuing naturally from the previous bars you are shown. Match the vibe, tempo and key you are given.`;

const DRUMS_SYSTEM = [
  `You are the DRUMMER in a two-piece AI jam band (drums and bass). You write one drum part at a time, as JSON, on a 16-step grid.`,
  GRID + ` Develop the groove and vary it a little from phrase to phrase; a small fill in bar 4 is welcome.`,
  `The bassist will read your bars and lock to your kick, so make the kick pattern deliberate and keep at least one kick in every bar.`,
  `Reply with ONLY a JSON object, with no prose and no markdown fences, in exactly this shape: {"why": "<one short sentence, max 140 characters, saying what you played and why>", "bars": [{"kick": [16 values], "snare": [16 values], "hat": [16 values]}, {...}, {...}, {...}]}`,
  `Rules: "bars" has exactly 4 objects. Each of kick, snare and hat is an array of exactly 16 integers, each 0 (silent) or 1 (hit). Output nothing outside the JSON object.`,
].join('\n\n');

const BASS_SYSTEM = [
  `You are the BASSIST in a two-piece AI jam band (drums and bass). You write one bass part at a time, as JSON, on a 16-step grid.`,
  GRID,
  `You are given the drummer's NEXT 4 BARS. Read them first and lock to the kick: in every bar that has a kick, you MUST play a note on the step of the first kick hit, and most of your other notes should land on kick steps or answer the gaps between kicks as syncopated pickups. Leave space where the drums are busy.`,
  `Reply with ONLY a JSON object, with no prose and no markdown fences, in exactly this shape: {"why": "<one short sentence, max 140 characters, saying how you locked to the drums and why>", "bars": [[{"step": 0, "note": "A2", "dur": "8n"}, ...], [...], [...], [...]]}`,
  `Rules: "bars" has exactly 4 arrays, one per bar, each with at least one note. step is an integer 0-15, and steps within a bar are strictly ascending (monophonic, one note per step). note is scientific pitch notation such as "A1", "C#2" or "Eb2", in the range E1 to E3. Stay in the key (mostly root, fifth and octave, with the occasional passing tone). dur is one of "16n", "8n", "8n.", "4n", "4n.", "2n", "1n" and should not run past the end of the bar. Output nothing outside the JSON object.`,
].join('\n\n');

/** Pull a JSON object out of a model reply, tolerating code fences and stray prose. */
function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found in the reply');
  return JSON.parse(stripped.slice(start, end + 1));
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

interface AgentResult<T> {
  data: T;
  latencyMs: number;
}

/** One agent = one chat completion against AIAND_MODEL, validated with zod, with a single retry that shows the model its mistake. Logs latency in ms per attempt and per agent call. */
async function runAgent<T>(name: string, system: string, user: string, schema: z.ZodType<T>): Promise<AgentResult<T>> {
  const messages: Msg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const effort = config.reasoningEffort ?? 'off';
  const callStarted = Date.now();
  let lastProblem = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const res = await getClient()
      .chat.completions.create({ model: config.model, messages, ...reasoningParams() })
      .catch((err: Error) => {
        console.error(`[${name}] attempt ${attempt}/2 request failed latency=${Date.now() - started}ms: ${err.message}`);
        throw err;
      });
    const latency = Date.now() - started;
    const text = res.choices[0]?.message?.content ?? '';
    const tokens = res.usage?.total_tokens ?? 'n/a';

    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(text));
      if (parsed.success) {
        const total = Date.now() - callStarted;
        console.log(`[${name}] attempt ${attempt}/2 ok latency=${latency}ms tokens=${tokens} effort=${effort}`);
        console.log(`[${name}] done latency=${total}ms attempts=${attempt}`);
        return { data: parsed.data, latencyMs: total };
      }
      problem = describeIssues(parsed.error);
    } catch (err) {
      problem = (err as Error).message;
    }

    console.warn(`[${name}] attempt ${attempt}/2 invalid latency=${latency}ms tokens=${tokens} effort=${effort}: ${problem}`);
    lastProblem = problem;
    messages.push(
      { role: 'assistant', content: text || '(empty reply)' },
      { role: 'user', content: `That reply was invalid: ${problem}. Return ONLY the corrected JSON object, nothing else.` },
    );
  }

  console.error(`[${name}] failed latency=${Date.now() - callStarted}ms attempts=2`);
  throw new AgentError(`${name} agent returned invalid JSON twice. Last problem: ${lastProblem}`);
}

const stepsOf = (row: number[]) => row.flatMap((v, i) => (v ? [i] : []));

export async function drumsAgent(state: JamState): Promise<AgentReply<DrumBar>> {
  const user = JSON.stringify({
    tempo: state.tempo,
    key: state.key,
    vibe: state.vibe,
    previous_drum_bars: state.bars.slice(-CONTEXT_BARS).map((b) => b.drums),
    task: 'Write the next 4 bars of drums.',
  });
  const { data, latencyMs } = await runAgent('drums', DRUMS_SYSTEM, user, drumsReplySchema);
  return { ...data, latencyMs };
}

export async function bassAgent(state: JamState, drums: DrumBar[]): Promise<AgentReply<BassBar>> {
  // The drummer may already be writing ahead, so some trailing bars have no bass yet: only finished bass bars count as history.
  const previousBass = state.bars.flatMap((b) => (b.bass ? [b.bass] : [])).slice(-CONTEXT_BARS);
  const user = JSON.stringify({
    tempo: state.tempo,
    key: state.key,
    vibe: state.vibe,
    drums_next_4_bars: drums.map((d, i) => ({
      bar: i + 1,
      kick_steps: stepsOf(d.kick),
      snare_steps: stepsOf(d.snare),
      hat_steps: stepsOf(d.hat),
      first_kick_step: stepsOf(d.kick)[0] ?? null,
    })),
    previous_bass_bars: previousBass,
    task: 'Write the next 4 bars of bass, locked to the kick of drums_next_4_bars.',
  });
  const { data, latencyMs } = await runAgent('bass', BASS_SYSTEM, user, bassReplySchema(drums));
  return { ...data, latencyMs };
}
