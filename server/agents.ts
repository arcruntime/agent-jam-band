import { jsonrepair } from 'jsonrepair';
import type OpenAI from 'openai';
import type { z } from 'zod';
import { meterOf, type Meter } from '../shared/meter.js';
import type { AgentReply, BassBar, ChordBar, ConductorOverrides, ConductorReply, DrumBar, JamState, MelodyBar } from '../shared/types.js';
import { config } from './config.js';
import {
  defaultBass,
  defaultConductor,
  defaultDrums,
  defaultKeys,
  defaultMelody,
  lockBassToKick,
  normalizePreset,
  presetFromVibe,
  previousBass,
  previousDrums,
  previousKeys,
  previousMelody,
} from './fallback.js';
import { getClient, reasoningParams } from './llm.js';
import { recall, remember, type BandMemoryItem, type MemoryAgent, type MemoryCtx } from './memory.js';
import {
  bassReplySchema,
  conductorReplySchema,
  describeIssues,
  drumsReplySchema,
  DURATIONS,
  type EchoClaim,
  keysReplySchema,
  melodyReplySchema,
} from './schemas.js';

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

export class AgentError extends Error {}

const CONTEXT_BARS = 8;
const DUR_LIST = DURATIONS.map((d) => `"${d}"`).join(', ');
const BAND = 'a four-piece AI jam band (drums, bass, keys and melody)';

// ---------- System prompts (each paragraph is one unbroken line) ----------

const gridParagraph = (m: Meter) =>
  `Grid: ${m.description} The song's bpm counts quarter notes per minute. Each turn you write the NEXT 4 BARS, continuing naturally from the previous bars you are shown. Match the vibe, bpm, key and meter given in the song object.`;

const ECHO_SHAPE = '"echoes": <null, or {"id": "<a motif id copied from band_memory>", "reason": "<at most 12 words>"}>';

const MEMORY_PARAGRAPH =
  'Band memory: the request includes "band_memory", up to 3 recent phrases ("motifs") that the OTHER players wrote in earlier blocks, each with an id, the player, the block number and a summary of what was played (steps and notes). It may be empty. When one of them would make a good musical callback, bring it back or answer it in your own part: repeat or vary the groove, quote the hook, echo the chords, and then set "echoes" to that motif\'s id with a short reason. Do not force it: if nothing fits, set "echoes" to null. Only ever use an id that appears in band_memory.';

const JSON_ONLY = 'Reply with ONLY a JSON object, with no prose, no comments and no markdown fences, in exactly this shape:';

const drumsSystem = (m: Meter) =>
  [
    `You are the DRUMMER in ${BAND}. You write one drum part at a time, as JSON, on a sixteenth-note step grid.`,
    `${gridParagraph(m)} Develop the groove and vary it a little from phrase to phrase; a small fill in bar 4 is welcome. Let the kick and snare follow the meter's grouping rather than forcing a 4/4 backbeat onto it.`,
    `The bassist locks to your kick, and the keys and melody players read your bars too, so make the kick pattern deliberate and keep at least one kick in every bar.`,
    MEMORY_PARAGRAPH,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying what you played and why>", ${ECHO_SHAPE}, "bars": [{"kick": [${m.stepsPerBar} values], "snare": [${m.stepsPerBar} values], "hat": [${m.stepsPerBar} values]}, {...}, {...}, {...}]}`,
    `Rules: "bars" has exactly 4 objects. Each of kick, snare and hat is an array of exactly ${m.stepsPerBar} integers, each 0 (silent) or 1 (hit), with at most 16 hits per bar across kick, snare and hat combined. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const bassSystem = (m: Meter) =>
  [
    `You are the BASSIST in ${BAND}. You write one bass part at a time, as JSON, on a sixteenth-note step grid.`,
    gridParagraph(m),
    `You are given the drummer's NEXT 4 BARS. Read them first and lock to the kick: in every bar that has a kick, you MUST play a note on the step of the first kick hit, and most of your other notes should land on kick steps or answer the gaps between kicks as syncopated pickups. Leave space where the drums are busy.`,
    MEMORY_PARAGRAPH,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying how you locked to the drums and why>", ${ECHO_SHAPE}, "bars": [[{"step": 0, "note": "A2", "dur": "8n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar, each with at least one note. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending (monophonic, one note per step). note is scientific pitch notation such as "A1", "C#2" or "Eb2", in the range E1 to E3. Stay in the key (mostly root, fifth and octave, with the occasional passing tone). dur is one of ${DUR_LIST} ("1m" holds for a whole bar) and should not run past the end of the bar. Use at most 16 notes per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const keysSystem = (m: Meter) =>
  [
    `You are the KEYS player in ${BAND}. You write one chord part at a time, as JSON, on a sixteenth-note step grid.`,
    gridParagraph(m),
    `You are given the drummer's and the bassist's NEXT 4 BARS. Read both first. Build your chords on the bass: the chord sounding at each step should include the note the bassist is playing there (or its most recent note), or be a sensible chord over it, so keys and bass never clash. Comp against the drums: place chord hits on kick or snare steps or on the meter's group starts, and leave space; long sustained chords are fine ("1m" holds a whole bar). Keep voicings above the bass, mostly between octave 3 and octave 5.`,
    MEMORY_PARAGRAPH,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying what chords you chose and why>", ${ECHO_SHAPE}, "bars": [[{"step": 0, "notes": ["A3", "C4", "E4"], "dur": "2n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar, each with 1 to 6 chord hits. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending. notes is 2 to 5 distinct pitches in scientific pitch notation such as "A3", "C#4" or "Eb4", all in octaves 2 to 5. dur is one of ${DUR_LIST}. Use at most 6 chord hits per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const melodySystem = (m: Meter) =>
  [
    `You are the MELODY player in ${BAND}. You write one lead line at a time, as JSON, on a sixteenth-note step grid.`,
    gridParagraph(m),
    `You are given the drummer's, the bassist's and the keys player's NEXT 4 BARS. Read all three first. Write a singable lead line in the key: put chord tones from the keys part on the downbeat and on the meter's group starts, use passing tones between them, repeat a short motif and vary it, and leave rests (an empty array is a rest bar) so the part breathes. Play single notes only.`,
    MEMORY_PARAGRAPH,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying how the melody fits the chords and why>", ${ECHO_SHAPE}, "bars": [[{"step": 0, "note": "E5", "dur": "4n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar; a bar may be empty but there must be at least 3 notes across the 4 bars. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending (monophonic). note is scientific pitch notation such as "E5" or "F#4", in octaves 4 to 6 (C4 to C6). dur is one of ${DUR_LIST}. Use at most 12 notes per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const CONDUCTOR_SYSTEM = [
  `You are the CONDUCTOR of ${BAND}. Before the band plays, you read the vibe the listener asked for and choose the tempo, key and time signature.`,
  `Pick a genre-appropriate BPM (quarter notes per minute, between 60 and 180). Reference points: ambient 60-80, reggae 70-90, lo-fi hip hop 80-90, boom bap 85-95, disco 115-125, house 120-128, bossa nova 120-140, techno 125-135, trap 130-150, dubstep 138-142, future bass 140-150, drum and bass 170-176. Read the mood too: a sleepy vibe sits at the low end of its genre and an energetic one at the high end.`,
  `Pick the time signature: "4/4" unless the vibe calls for something else (a waltz or jazz waltz is "3/4", a shuffle, ballad or jig feel is "6/8", progressive or odd-meter vibes can use "5/4" or "7/8"). Pick a key with a mode that suits the mood, written as a note name plus a mode, for example "A minor", "F# dorian" or "Eb major".`,
  `Also pick the sound preset that matches the genre, one of "lofi" (lo-fi, chill, jazzy, bossa nova, boom bap), "futurebass" (future bass, EDM, trap, dubstep, synth pop), "house" (house, techno, disco, dance), "rock" (rock, punk, metal, indie, funk, blues) or "ambient" (ambient, cinematic, drone, new age).`,
  `If the request includes "fixed_by_user", those values were chosen by the listener: return them exactly as given and choose everything else to suit them.`,
  `${JSON_ONLY} {"bpm": <integer 60-180>, "key": "<tonic> <mode>", "timeSignature": "<one of 4/4, 3/4, 5/4, 7/8, 6/8>", "preset": "<one of lofi, futurebass, house, rock, ambient>", "why": "<one short sentence, at most 20 words, naming the genre or feel and why you chose this tempo, key and meter>"}`,
].join('\n\n');

// ---------- Running one agent ----------

/**
 * Pull a JSON object out of a model reply: cut away prose and code fences, repair the usual damage (comments, trailing commas, single quotes, truncation) with jsonrepair, then parse.
 * The object is cut out first because jsonrepair would otherwise wrap stray prose into an array.
 */
function parseReply(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in the reply');
  const end = stripped.lastIndexOf('}');
  const candidate = end > start ? stripped.slice(start, end + 1) : stripped.slice(start);
  return JSON.parse(jsonrepair(candidate));
}

interface AgentResult<T> {
  data: T;
  latencyMs: number;
}

/** Flips to false (once, for the life of the process) if the provider turns out not to accept response_format. */
let jsonModeSupported = true;

const rejectsJsonMode = (err: unknown) => {
  const e = err as { status?: number; message?: string };
  return (e.status === 400 || e.status === 422) && /response_format|json_object|json mode/i.test(e.message ?? '');
};

/** One chat completion in JSON mode ({ response_format: { type: "json_object" } }) at the configured reasoning effort. */
async function createCompletion(messages: Msg[], pinnedEffort?: string) {
  const params = { model: config.model, messages, ...reasoningParams(pinnedEffort) };
  if (jsonModeSupported) {
    try {
      return await getClient().chat.completions.create({ ...params, response_format: { type: 'json_object' } });
    } catch (err) {
      if (!rejectsJsonMode(err)) throw err;
      jsonModeSupported = false;
      console.warn('[llm] the provider rejected response_format=json_object; continuing without it (jsonrepair and zod still apply)');
    }
  }
  return getClient().chat.completions.create(params);
}

/**
 * One agent = one JSON-mode chat completion against AIAND_MODEL, repaired with jsonrepair and validated with zod, with a single retry that shows the model its mistake.
 * A failed request counts as a failed attempt too. Logs latency in ms and token usage per attempt and per agent call.
 * Throws AgentError when both attempts fail; the agent functions below turn that into a quiet fallback.
 */
async function runAgent<T>(name: string, system: string, user: string, schema: z.ZodType<T>, pinnedEffort?: string): Promise<AgentResult<T>> {
  const messages: Msg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const effort = reasoningParams(pinnedEffort).reasoning_effort ?? 'off';
  const callStarted = Date.now();
  let lastProblem = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    let text = '';
    let tokens = 'n/a';
    let problem: string;
    try {
      const res = await createCompletion(messages, pinnedEffort);
      text = res.choices[0]?.message?.content ?? '';
      tokens = res.usage ? `${res.usage.prompt_tokens}+${res.usage.completion_tokens}=${res.usage.total_tokens}` : 'n/a';
      const parsed = schema.safeParse(parseReply(text));
      if (parsed.success) {
        const total = Date.now() - callStarted;
        console.log(`[${name}] attempt ${attempt}/2 ok latency=${Date.now() - started}ms tokens(prompt+completion=total)=${tokens} effort=${effort}`);
        console.log(`[${name}] done latency=${total}ms attempts=${attempt}`);
        return { data: parsed.data, latencyMs: total };
      }
      problem = describeIssues(parsed.error);
    } catch (err) {
      problem = (err as Error).message;
    }

    console.warn(`[${name}] attempt ${attempt}/2 failed latency=${Date.now() - started}ms tokens(prompt+completion=total)=${tokens} effort=${effort}: ${problem}`);
    lastProblem = problem;
    if (text) {
      messages.push(
        { role: 'assistant', content: text },
        { role: 'user', content: `That reply was invalid: ${problem}. Return ONLY the corrected JSON object, nothing else.` },
      );
    }
  }

  console.error(`[${name}] gave up latency=${Date.now() - callStarted}ms attempts=2`);
  throw new AgentError(`${name} agent failed twice. Last problem: ${lastProblem}`);
}

interface Fallback<B> {
  bars: B[];
  source: string;
}

type Ctx = MemoryCtx | undefined;

/**
 * Runs an agent; if both attempts fail, returns a normal-looking reply that reuses the agent's previous block (or a built-in pattern) instead.
 * The failure goes to the server console only. The reply has no "why", so the UI shows nothing for it.
 * Either way the phrase is written to the band's memory (Neo4j), without waiting for the write and without ever failing the reply.
 */
async function guarded<B>(
  name: MemoryAgent,
  ctx: Ctx,
  run: () => Promise<AgentResult<{ why: string; bars: B[]; echoes?: EchoClaim | null }>>,
  fallback: () => Fallback<B>,
): Promise<AgentReply<B>> {
  const started = Date.now();
  try {
    const { data, latencyMs } = await run();
    const { echoes = null, ...reply } = data;
    if (ctx) remember(ctx, name, { bars: reply.bars, why: reply.why, echoes, fallback: false });
    return { ...reply, latencyMs, ...(echoes ? { echoed: true } : {}) };
  } catch (err) {
    const { bars, source } = fallback();
    console.error(`[${name}] FALLBACK (${source}) because: ${(err as Error).message}`);
    if (ctx) remember(ctx, name, { bars, why: '', echoes: null, fallback: true });
    return { why: '', bars, latencyMs: Date.now() - started, fallback: true };
  }
}

// ---------- What each agent is shown ----------

/** The song settings every musician gets: bpm and meter first. */
function song(state: JamState, m: Meter) {
  return {
    bpm: state.tempo,
    key: state.key,
    time_signature: state.timeSignature,
    steps_per_bar: m.stepsPerBar,
    group_start_steps: m.accentSteps,
    vibe: state.vibe,
  };
}

const stepsOf = (row: number[]) => row.flatMap((v, i) => (v ? [i] : []));

/** Finished bars of one part from the shared state, newest last. The drummer may be writing ahead, so later parts can still be null. */
function history<K extends 'drums' | 'bass' | 'keys' | 'melody'>(state: JamState, part: K) {
  return state.bars.flatMap((b) => (b[part] ? [b[part]] : [])).slice(-CONTEXT_BARS);
}

const drumsView = (drums: DrumBar[]) =>
  drums.map((d, i) => ({ bar: i + 1, kick_steps: stepsOf(d.kick), snare_steps: stepsOf(d.snare), hat_steps: stepsOf(d.hat), first_kick_step: stepsOf(d.kick)[0] ?? null }));

// ---------- The agents ----------

export async function conductorAgent(vibe: string, overrides: ConductorOverrides): Promise<ConductorReply> {
  const started = Date.now();
  const user = JSON.stringify({
    vibe,
    ...(Object.keys(overrides).length ? { fixed_by_user: overrides } : {}),
    task: 'Choose the bpm, key, time signature and sound preset for this vibe.',
  });
  try {
    // The conductor always runs at reasoning_effort "low".
    const { data, latencyMs } = await runAgent('conductor', CONDUCTOR_SYSTEM, user, conductorReplySchema, 'low');

    // The listener's manual choices always win, even if the model drifted from them.
    const bpm = overrides.bpm ?? data.bpm;
    const timeSignature = overrides.timeSignature ?? data.timeSignature;
    if (bpm !== data.bpm || timeSignature !== data.timeSignature) {
      console.warn(`[conductor] model picked ${data.bpm} BPM in ${data.timeSignature}; applying the listener's ${bpm} BPM in ${timeSignature}`);
    }
    const preset = normalizePreset(data.preset) ?? presetFromVibe(vibe);
    if (!normalizePreset(data.preset)) console.warn(`[conductor] unusable preset ${JSON.stringify(data.preset)}; using "${preset}" from the vibe`);
    return { bpm, key: data.key, timeSignature, preset, why: data.why, latencyMs };
  } catch (err) {
    const d = defaultConductor(vibe, overrides);
    console.error(`[conductor] FALLBACK (defaults: ${d.bpm} BPM, ${d.key}, ${d.timeSignature}, ${d.preset}) because: ${(err as Error).message}`);
    return { ...d, why: '', latencyMs: Date.now() - started, fallback: true };
  }
}

const recallFor = (ctx: Ctx, agent: MemoryAgent): Promise<BandMemoryItem[]> => (ctx ? recall(ctx, agent) : Promise.resolve([]));

export async function drumsAgent(state: JamState, ctx?: Ctx): Promise<AgentReply<DrumBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    previous_drum_bars: history(state, 'drums'),
    band_memory: await recallFor(ctx, 'drums'),
    task: 'Write the next 4 bars of drums.',
  });
  return guarded<DrumBar>(
    'drums',
    ctx,
    () => runAgent('drums', drumsSystem(m), user, drumsReplySchema(m.stepsPerBar)),
    () => {
      const previous = previousDrums(state);
      return previous ? { bars: previous, source: 'previous block' } : { bars: defaultDrums(m), source: 'built-in pattern' };
    },
  );
}

export async function bassAgent(state: JamState, drums: DrumBar[], ctx?: Ctx): Promise<AgentReply<BassBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    drums_next_4_bars: drumsView(drums),
    previous_bass_bars: history(state, 'bass'),
    band_memory: await recallFor(ctx, 'bass'),
    task: 'Write the next 4 bars of bass, locked to the kick of drums_next_4_bars.',
  });
  return guarded<BassBar>(
    'bass',
    ctx,
    () => runAgent('bass', bassSystem(m), user, bassReplySchema(m.stepsPerBar, drums)),
    () => {
      const previous = previousBass(state);
      return previous
        ? { bars: lockBassToKick(previous, drums, state.key), source: 'previous block, re-locked to the kick' }
        : { bars: defaultBass(state.key, drums), source: 'built-in pattern' };
    },
  );
}

export async function keysAgent(state: JamState, drums: DrumBar[], bass: BassBar[], ctx?: Ctx): Promise<AgentReply<ChordBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    drums_next_4_bars: drumsView(drums),
    bass_next_4_bars: bass,
    previous_keys_bars: history(state, 'keys'),
    band_memory: await recallFor(ctx, 'keys'),
    task: 'Write the next 4 bars of chords over the bass and drums above.',
  });
  return guarded<ChordBar>(
    'keys',
    ctx,
    () => runAgent('keys', keysSystem(m), user, keysReplySchema(m.stepsPerBar)),
    () => {
      const previous = previousKeys(state);
      return previous ? { bars: previous, source: 'previous block' } : { bars: defaultKeys(state.key), source: 'built-in pattern' };
    },
  );
}

export async function melodyAgent(state: JamState, drums: DrumBar[], bass: BassBar[], keys: ChordBar[], ctx?: Ctx): Promise<AgentReply<MelodyBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    drums_next_4_bars: drumsView(drums),
    bass_next_4_bars: bass,
    keys_next_4_bars: keys,
    previous_melody_bars: history(state, 'melody'),
    band_memory: await recallFor(ctx, 'melody'),
    task: 'Write the next 4 bars of melody over the chords, bass and drums above.',
  });
  return guarded<MelodyBar>(
    'melody',
    ctx,
    () => runAgent('melody', melodySystem(m), user, melodyReplySchema(m.stepsPerBar)),
    () => {
      const previous = previousMelody(state);
      return previous ? { bars: previous, source: 'previous block' } : { bars: defaultMelody(state.key), source: 'built-in pattern' };
    },
  );
}
