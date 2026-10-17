import { jsonrepair } from 'jsonrepair';
import type OpenAI from 'openai';
import type { z } from 'zod';
import { BLOCK_BARS, defaultArrangement, parseChord, sanitizeArrangement, sectionFromText, sectionNameOf, type BlockPlan, type SectionName } from '../shared/arrangement.js';
import { meterOf, type Meter } from '../shared/meter.js';
import { SOUND_PRESETS, isSoundPreset, type SoundPreset } from '../shared/presets.js';
import { VOX_BRIEF, VOX_SECTION, VOX_STYLE, voxWindows, type VoxStyle, type VoxWindow } from '../shared/vox.js';
import type { AgentReply, BassBar, ChordBar, ConductorOverrides, ConductorReply, ConductorSettings, DrumBar, JamState, MelodyBar, TokenUsage, VoxBar } from '../shared/types.js';
import { config } from './config.js';
import {
  defaultBass,
  defaultConductor,
  explicitMeter,
  defaultDrums,
  defaultKeys,
  defaultMelody,
  lockBassToKick,
  normalizePreset,
  presetFromVibe,
  steerFallback,
  previousBass,
  previousDrums,
  previousKeys,
  previousMelody,
  previousVox,
  conformVox,
  chopMelody,
  nameOf,
  shapeMelody,
  silentVox,
  voxRegisterFor,
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
  voxReplySchema,
} from './schemas.js';

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

export class AgentError extends Error {
  constructor(
    message: string,
    /** Tokens the failed attempts still used */
    readonly usage?: TokenUsage,
  ) {
    super(message);
  }
}

const CONTEXT_BARS = 8;
const DUR_LIST = DURATIONS.map((d) => `"${d}"`).join(', ');
const BAND = 'a five-piece AI jam band (drums, bass, keys, melody and vox)';

// ---------- System prompts (each paragraph is one unbroken line) ----------

const gridParagraph = (m: Meter) =>
  `Grid: ${m.description} The song's bpm counts quarter notes per minute. Each turn you write the NEXT 4 BARS, continuing naturally from the previous bars you are shown. Match the vibe, bpm, key and meter given in the song object.`;

const ECHO_SHAPE = '"echoes": <null, or {"id": "<a motif id copied from band_memory>", "reason": "<at most 12 words>"}>';

const MEMORY_PARAGRAPH =
  'Band memory: the request includes "band_memory", up to 3 recent phrases ("motifs") that the OTHER players wrote in earlier blocks, each with an id, the player, the block number and a summary of what was played (steps and notes). It may be empty. When one of them would make a good musical callback, bring it back or answer it in your own part: repeat or vary the groove, quote the hook, echo the chords, and then set "echoes" to that motif\'s id with a short reason. Do not force it: if nothing fits, set "echoes" to null. Only ever use an id that appears in band_memory.';

const NOTE_VELOCITY =
  'Dynamics: each note or chord may carry an optional "velocity" from 0 to 1 (default 0.8). Use it to shape the phrase: stronger on beats 1 and 3, softer on pickups and ghost notes (about 0.3 to 0.5). Leave it out where 0.8 is right.';

const drumsVelocity = (steps: number) =>
  `Dynamics: a bar may carry an optional "velocity" object with any of "kick", "snare" and "hat", each an array of exactly ${steps} numbers from 0 to 1 giving the strength of the hit on that step (steps with a 0 in the hit row are ignored, and a row you leave out plays at the default 0.8). Accent beats 1 and 3, keep backbeat snares strong, and play ghost hats and ghost snares at about 0.3 to 0.5.`;

const STEER_PARAGRAPH =
  'Live steering: if the song object has "listener_steer", the listener changed the direction while the band was playing. Follow its "direction" (the conductor\'s instruction to the band) and its "text" from this phrase on; they override the vibe wherever the two conflict. Bars you are shown from before the change may be left out because they used a different meter.';

const SECTION_PARAGRAPH =
  'Song structure: the request may include "section" (the part of the song this phrase belongs to: intro, build, drop or breakdown, with "what_to_play" for your instrument) and "chords_per_bar" (the chord planned for each of the 4 bars, with its tones). Play the section: intro and breakdown are sparse and spacious, a build rises in energy bar by bar, a drop is the full band at full energy. Follow the planned chords: the chord of each bar is the harmony for that whole bar. Playing sparse never breaks the rules below (the drums, bass and keys still have at least one hit or note in every bar, and the melody at least 3 notes in all). If there is no "section", just carry on as before.';

const JSON_ONLY = 'Reply with ONLY a JSON object, with no prose, no comments and no markdown fences, in exactly this shape:';

const drumsSystem = (m: Meter) =>
  [
    `You are the DRUMMER in ${BAND}. You write one drum part at a time, as JSON, on a sixteenth-note step grid.`,
    `${gridParagraph(m)} Develop the groove and vary it a little from phrase to phrase; a small fill in bar 4 is welcome. Let the kick and snare follow the meter's grouping rather than forcing a 4/4 backbeat onto it.`,
    `The bassist locks to your kick, and the keys and melody players read your bars too, so make the kick pattern deliberate and keep at least one kick in every bar.`,
    MEMORY_PARAGRAPH,
    STEER_PARAGRAPH,
    SECTION_PARAGRAPH,
    drumsVelocity(m.stepsPerBar),
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying what you played and why>", ${ECHO_SHAPE}, "bars": [{"kick": [${m.stepsPerBar} values], "snare": [${m.stepsPerBar} values], "hat": [${m.stepsPerBar} values]}, {...}, {...}, {...}]}`,
    `Rules: "bars" has exactly 4 objects. Each of kick, snare and hat is an array of exactly ${m.stepsPerBar} integers, each 0 (silent) or 1 (hit), with at most 16 hits per instrument per bar (kick, snare and hat are each limited to 16, separately). Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const bassSystem = (m: Meter) =>
  [
    `You are the BASSIST in ${BAND}. You write one bass part at a time, as JSON, on a sixteenth-note step grid.`,
    gridParagraph(m),
    `You are given the drummer's NEXT 4 BARS. Read them first and lock to the kick: in every bar that has a kick, you MUST play a note on the step of the first kick hit, and most of your other notes should land on kick steps or answer the gaps between kicks as syncopated pickups. Leave space where the drums are busy.`,
    MEMORY_PARAGRAPH,
    STEER_PARAGRAPH,
    SECTION_PARAGRAPH,
    NOTE_VELOCITY,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying how you locked to the drums and why>", ${ECHO_SHAPE}, "bars": [[{"step": 0, "note": "A2", "dur": "8n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar, each with at least one note. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending (monophonic, one note per step). note is scientific pitch notation such as "A1", "C#2" or "Eb2", in the range E1 to E3. Stay in the key (mostly root, fifth and octave, with the occasional passing tone). dur is one of ${DUR_LIST} ("1m" holds for a whole bar) and should not run past the end of the bar. Use at most 16 notes per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const keysSystem = (m: Meter) =>
  [
    `You are the KEYS player in ${BAND}. You write one chord part at a time, as JSON, on a sixteenth-note step grid.`,
    gridParagraph(m),
    `You are given the drummer's and the bassist's NEXT 4 BARS. Read both first. Build your chords on the bass: the chord sounding at each step should include the note the bassist is playing there (or its most recent note), or be a sensible chord over it, so keys and bass never clash. Comp against the drums: place chord hits on kick or snare steps or on the meter's group starts, and leave space; long sustained chords are fine ("1m" holds a whole bar). Keep voicings above the bass, mostly between octave 3 and octave 5.`,
    MEMORY_PARAGRAPH,
    STEER_PARAGRAPH,
    SECTION_PARAGRAPH,
    NOTE_VELOCITY,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying what chords you chose and why>", ${ECHO_SHAPE}, "bars": [[{"step": 0, "notes": ["A3", "C4", "E4"], "dur": "2n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar, each with 1 to 6 chord hits. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending. notes is 2 to 5 distinct pitches in scientific pitch notation such as "A3", "C#4" or "Eb4", all in octaves 2 to 5. dur is one of ${DUR_LIST}. Use at most 6 chord hits per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const melodySystem = (m: Meter) =>
  [
    `You are the MELODY player in ${BAND}. You write one lead line at a time, as JSON, on a sixteenth-note step grid.`,
    gridParagraph(m),
    `You are given the drummer's, the bassist's and the keys player's NEXT 4 BARS. Read all three first. Write a singable lead line in the key: put chord tones from the keys part on the downbeat and on the meter's group starts, use passing tones between them, repeat a short motif and vary it, and leave rests (an empty array is a rest bar) so the part breathes. Play single notes only.`,
    `Sometimes a vox player answers you. If "rest_for_vox" is given, those steps of those bars belong to the vox: play nothing that starts inside them, and let a note end before the window starts. Play your phrase in the other bars and on the other steps, and leave a clear gap so the vox's reply can be heard (this is call and response).`,
    MEMORY_PARAGRAPH,
    STEER_PARAGRAPH,
    SECTION_PARAGRAPH,
    NOTE_VELOCITY,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying how the melody fits the chords and why>", ${ECHO_SHAPE}, "bars": [[{"step": 0, "note": "E5", "dur": "4n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar; a bar may be empty but there must be at least 3 notes across the 4 bars. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending (monophonic). note is scientific pitch notation such as "E5" or "F#4", in octaves 4 to 6 (C4 to C6). dur is one of ${DUR_LIST}. Use at most 12 notes per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

const voxSystem = (m: Meter, style: VoxStyle) =>
  [
    `You are the VOX player in ${BAND}. You write robot vocal chops, as JSON, on a sixteenth-note step grid: vowel-like hits that a synth voice sings through filters (no words, only vowels). Your style for this genre is "${style}": ${VOX_BRIEF[style]}`,
    gridParagraph(m),
    `You are given the drummer's, the keys player's and the melody player's NEXT 4 BARS. Read them first. The melody and you take turns (call and response): "your_windows" lists the bars and the steps of them where only you play, and the melody rests there. Write hits ONLY inside your windows, and nothing outside them. Sing the melody's own pitches or a chord tone from the keys part, in the "register" given (the melody keeps its own register, so you never share it): any octave is fine, it will be moved into your register. Every hit has a "vowel", exactly one of "ah" (open and wide), "oh" (round), "ee" (bright and tight) or "oo" (dark and soft).`,
    `You never cover the melody: keep velocities between 0.5 and 0.8. An empty array is a rest bar, which is normal for any bar without a window.`,
    MEMORY_PARAGRAPH,
    `You are especially good at calling back a melody motif from band_memory as a chop: keep its pitches, change the rhythm and give each hit a vowel, then set "echoes" to its id.`,
    STEER_PARAGRAPH,
    SECTION_PARAGRAPH,
    NOTE_VELOCITY,
    `${JSON_ONLY} {"why": "<one short sentence, at most 20 words, saying what you chopped and why>", ${ECHO_SHAPE}, "bars": [[{"step": 10, "note": "E6", "vowel": "ah", "dur": "16n"}, ...], [...], [...], [...]]}`,
    `Rules: "bars" has exactly 4 arrays, one per bar, and a bar may be empty. step is an integer from 0 to ${m.stepsPerBar - 1}, and steps within a bar are strictly ascending (monophonic, one chop per step). note is scientific pitch notation such as "E4" or "G#5", in the key. vowel is exactly one of "ah", "oh", "ee" or "oo". dur is one of ${DUR_LIST}. Use at most 8 chops per bar. Keep it compact: no comments, no extra keys, and "why" is at most 20 words. Output nothing outside the JSON object.`,
  ].join('\n\n');

/** The preset menu the conductor chooses from (it must pick the closest one; there is no other sound to choose). */
const PRESET_CHOICES =
  'one of "lofi" (lo-fi, chill, bossa nova, study beats), "hiphop" (boom bap, hip hop, rap, heavy swing), "jazz" (jazz, swing, bebop, swung ride and walking bass), "futurebass" (future bass, EDM, trap, dubstep, synth pop), "house" (house, techno, disco, dance, garage), "dnb" (drum and bass, jungle, breakbeats, reese bass), "rock" (rock, punk, metal, indie, funk, blues) or "ambient" (ambient, cinematic, drone, new age). There are no other presets, so choose the closest one.';
const PRESET_NAMES = SOUND_PRESETS.join(', ');

const CONDUCTOR_SYSTEM = [
  `You are the CONDUCTOR of ${BAND}. Before the band plays, you read the vibe the listener asked for and choose the tempo, key and time signature.`,
  `Pick a genre-appropriate BPM (quarter notes per minute, between 60 and 180). Reference points: ambient 60-80, reggae 70-90, lo-fi hip hop 80-90, boom bap 85-95, disco 115-125, house 120-128, bossa nova 120-140, techno 125-135, trap 130-150, dubstep 138-142, future bass 140-150, drum and bass 170-176. Read the mood too: a sleepy vibe sits at the low end of its genre and an energetic one at the high end.`,
  `Pick the time signature: "4/4" unless the vibe calls for something else (a waltz or jazz waltz is "3/4", a shuffle, ballad or jig feel is "6/8", progressive or odd-meter vibes can use "5/4" or "7/8"). Pick a key with a mode that suits the mood, written as a note name plus a mode, for example "A minor", "F# dorian" or "Eb major".`,
  `Also pick the sound preset that matches the genre, ${PRESET_CHOICES}`,
  `Also plan the song structure as "sections", in playing order. Each section has a "name" (exactly one of "intro", "build", "drop" or "breakdown"), a length "bars" (a multiple of 4 from 4 to 32) and "chords": 1 to 8 chord symbols in the key you chose (for example "Am", "F", "C", "G7", "Dm7", "Cmaj7", "Esus4"), which repeat to give one chord per bar, so 4 chords over 8 bars play twice. The usual plan is intro 8 bars, build 8, drop 16, breakdown 8, drop 16, and then the song loops back to the start; adapt it to the vibe if you like (3 to 7 sections, at most 64 bars in total). Give the intro and the breakdown calm progressions, make the build climb, and give the drops the strongest, most memorable progression.`,
  `If the request includes "fixed_by_user", those values were chosen by the listener: return them exactly as given and choose everything else to suit them.`,
  `${JSON_ONLY} {"bpm": <integer 60-180>, "key": "<tonic> <mode>", "timeSignature": "<one of 4/4, 3/4, 5/4, 7/8, 6/8>", "preset": "<one of ${PRESET_NAMES}>", "sections": [{"name": "intro", "bars": 8, "chords": ["Am", "F", "C", "G"]}, {"name": "build", "bars": 8, "chords": [...]}, ...], "why": "<one short sentence, at most 20 words, naming the preset you picked and why, for example: Jazz preset for the swung ride and walking bass at 128 BPM. If no preset fits the genre exactly, say which one is closest, for example: No garage kit, using house.>"}`,
].join('\n\n');

const STEER_SYSTEM = [
  `You are the CONDUCTOR of ${BAND}. The band is already playing. The listener types a short steering instruction, sometimes just a word or a button label such as "7/8", "5/4", "half-time", "drop", "darker" or "genre: jazz", and you return the updated settings for the next phrase.`,
  `You are given the "current" settings and the instruction. Change only what the instruction asks for and keep everything else as in "current". A meter such as "7/8" or "waltz" changes the time signature (and nudges nothing else unless needed). "half-time" means a half-time feel: keep the bpm, and tell the drummer to put the snare on beat three and thin out the hats. The song is arranged in sections (intro, build, drop, breakdown), and a section name jumps the band to that part of the song at the next block boundary: "drop" is the full-energy section (tell drums and bass to hit hard with a heavy kick and sub bass and the keys to stab), "breakdown" is the stripped-back section, "build" is the rising-energy section and "intro" is the sparse opening. For a section jump keep the bpm, key, time signature and preset exactly as in "current" and set "section" to that name. "darker" means a darker mood: move the key toward minor (or phrygian if it is already minor), take a little off the tempo, and tell the band for lower voicings and more space. "genre: X" or any genre name means switch to that genre: pick a genre-appropriate bpm, key, meter and preset. Anything else, use your judgement as a bandleader.`,
  `Reference BPMs: ambient 60-80, reggae 70-90, lo-fi hip hop 80-90, boom bap 85-95, jazz 100-140, disco 115-125, house 120-128, bossa nova 120-140, techno 125-135, trap 130-150, dubstep 138-142, future bass 140-150, drum and bass 170-176. The time signature is one of "4/4", "3/4", "5/4", "7/8", "6/8". The preset is one of the available sound presets: ${PRESET_CHOICES}`,
  `${JSON_ONLY} {"bpm": <integer 60-180>, "key": "<tonic> <mode>", "timeSignature": "<one of 4/4, 3/4, 5/4, 7/8, 6/8>", "preset": "<one of ${PRESET_NAMES}>", "section": <null, or "intro", "build", "drop" or "breakdown" when the listener asks to jump to that part of the song>, "why": "<one short sentence, at most 20 words, spoken by you to the band, naming the change (and the preset, if you changed it, and why) and giving each player a hint, for example: Switching to 7/8: drums, think odd grouping 2+2+3. If a requested genre has no preset, say which one is closest, for example: No garage kit, using house.>"}`,
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
  tokens?: TokenUsage;
}

/** Adds one completion's usage report (if it had one) to a running total. */
function addUsage(total: TokenUsage | undefined, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined | null): TokenUsage | undefined {
  if (!usage) return total;
  const prompt = (total?.prompt ?? 0) + (usage.prompt_tokens ?? 0);
  const completion = (total?.completion ?? 0) + (usage.completion_tokens ?? 0);
  return { prompt, completion, total: (total?.total ?? 0) + (usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) };
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
  let usage: TokenUsage | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    let text = '';
    let tokens = 'n/a';
    let problem: string;
    try {
      const res = await createCompletion(messages, pinnedEffort);
      text = res.choices[0]?.message?.content ?? '';
      tokens = res.usage ? `${res.usage.prompt_tokens}+${res.usage.completion_tokens}=${res.usage.total_tokens}` : 'n/a';
      usage = addUsage(usage, res.usage);
      const parsed = schema.safeParse(parseReply(text));
      if (parsed.success) {
        const total = Date.now() - callStarted;
        console.log(`[${name}] attempt ${attempt}/2 ok latency=${Date.now() - started}ms tokens(prompt+completion=total)=${tokens} effort=${effort}`);
        console.log(`[${name}] done latency=${total}ms attempts=${attempt}`);
        return { data: parsed.data, latencyMs: total, tokens: usage };
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
  throw new AgentError(`${name} agent failed twice. Last problem: ${lastProblem}`, usage);
}

interface Fallback<B> {
  bars: B[];
  source: string;
}

type Ctx = MemoryCtx | undefined;

/** Bars that are all empty arrays (only a vox can write these; drum bars are objects). */
const silent = (bars: unknown[]) => bars.every((b) => Array.isArray(b) && b.length === 0);

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
    const { data, latencyMs, tokens } = await run();
    const { echoes = null, ...reply } = data;
    // A silent block (a vox sitting out) has nothing to call back, so it adds nothing to the band's memory.
    if (ctx && !silent(reply.bars)) remember(ctx, name, { bars: reply.bars, why: reply.why, echoes, fallback: false });
    return { ...reply, latencyMs, ...(tokens ? { tokens } : {}), ...(echoes ? { echoed: true } : {}) };
  } catch (err) {
    const { bars, source } = fallback();
    console.error(`[${name}] FALLBACK (${source}) because: ${(err as Error).message}`);
    if (ctx && !silent(bars)) remember(ctx, name, { bars, why: '', echoes: null, fallback: true });
    const spent = err instanceof AgentError ? err.usage : undefined; // the failed attempts still cost tokens
    return { why: '', bars, latencyMs: Date.now() - started, fallback: true, ...(spent ? { tokens: spent } : {}) };
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
    ...(state.steer ? { listener_steer: { text: state.steer.text, direction: state.steer.direction } } : {}),
  };
}

/** What each instrument does in each part of the song (the same words go to the agent as "what_to_play"). */
const SECTION_GUIDE: Record<SectionName, { energy: string } & Record<MemoryAgent, string>> = {
  intro: {
    energy: 'low: the song is just starting',
    drums: 'sparse: a soft kick on the first beat of each bar and a light closed hat or rim, no full backbeat and no fill',
    bass: 'minimal: one long root note per bar (the root of that bar\'s chord), soft and unhurried',
    keys: 'soft sustained chords: the chord of each bar held long ("1m") at low velocity (about 0.4 to 0.6)',
    melody: 'mostly rests: three or four sparse, long notes across the 4 bars, chord tones, quiet',
    vox: 'silent: all four bars empty',
  },
  build: {
    energy: 'rising: more energy every bar, heading for the drop',
    drums: 'rising energy: start sparse and add hits every bar (busier hats, snare on every beat or a roll in bars 3 and 4) and play a fill in bar 4 leading into the drop',
    bass: 'growing: root notes that get busier bar by bar, with octave jumps by bar 4, following the chord roots',
    keys: 'rising: begin with held chords, then repeated stabs or pulses in bars 3 and 4 with velocity climbing, following the chords',
    melody: 'a rising line: ascending notes that come more often each bar and finish high in bar 4, built from the chord tones',
    vox: 'rising: 2 or 3 chops in bar 1 and 2, then 4 to 6 quick 16th-note chops per bar climbing in pitch in bars 3 and 4, answering the melody',
  },
  drop: {
    energy: 'full: the whole band at full energy, the payoff of the song',
    drums: 'full energy: the main groove at full strength with a strong kick and snare backbeat, driving hats and accents on the first beat',
    bass: 'full: the driving bassline locked to the kick and syncopated, built on the root of each bar\'s chord, at strong velocity',
    keys: 'full: bright rhythmic chord stabs on kick and snare steps and on the group starts, strong velocity, the chord of each bar',
    melody: 'the hook: the most memorable, rhythmic motif of the song, 6 to 12 notes in the strongest bars, on chord tones',
    vox: 'the vocal hook: 5 to 8 rhythmic chops in every bar, on the off-beats and in the gaps of the melody, echoing the melody\'s motif, with leaps between vowels, so the hook is clearly heard',
  },
  breakdown: {
    energy: 'low: stripped back, the song takes a breath',
    drums: 'stripped back: only a kick on the first beat of each bar (or very few hits), no snare, minimal hats, leave air',
    bass: 'sparse: one held root or sub note per bar with a long duration',
    keys: 'airy: one long soft chord per bar ("1m"), the chord of that bar, lowest velocity, wide open space',
    melody: 'sparse and emotional: a few long notes on chord tones with rests between them',
    vox: 'very sparse: at most one soft held vowel per bar ( "oo" or "ah" ), or silence',
  },
};

/** The section and chords for one block, as the agents read them. Empty when the request carried no plan. */
function planView(plan: BlockPlan | undefined, who: MemoryAgent) {
  if (!plan) return {};
  const guide = SECTION_GUIDE[plan.section];
  return {
    section: {
      name: plan.section,
      bars_in_section: `${plan.sectionBar}-${plan.sectionBar + BLOCK_BARS - 1} of ${plan.sectionBars}`,
      energy: guide.energy,
      what_to_play: guide[who],
    },
    ...(who === 'drums' ? {} : { chords_per_bar: plan.chords.map((chord, i) => ({ bar: i + 1, chord, tones: parseChord(chord)?.tones ?? null })) }),
  };
}

const stepsOf = (row: number[]) => row.flatMap((v, i) => (v ? [i] : []));

/** Finished bars of one part from the shared state, newest last. The drummer may be writing ahead, so later parts can still be null. */
function history<K extends 'drums' | 'bass' | 'keys' | 'melody' | 'vox'>(state: JamState, part: K) {
  // Bars from another meter have a different step grid, so they are left out after a live meter change.
  const sameMeter = state.bars.filter((b) => !b.timeSignature || b.timeSignature === state.timeSignature);
  return sameMeter.flatMap((b) => (b[part] ? [b[part]] : [])).slice(-CONTEXT_BARS);
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
    const { data, latencyMs, tokens } = await runAgent('conductor', CONDUCTOR_SYSTEM, user, conductorReplySchema, 'low');

    // The listener's manual choices always win, even if the model drifted from them.
    const bpm = overrides.bpm ?? data.bpm;
    const timeSignature = overrides.timeSignature ?? data.timeSignature;
    if (bpm !== data.bpm || timeSignature !== data.timeSignature) {
      console.warn(`[conductor] model picked ${data.bpm} BPM in ${data.timeSignature}; applying the listener's ${bpm} BPM in ${timeSignature}`);
    }
    const preset = normalizePreset(data.preset) ?? presetFromVibe(vibe);
    if (!normalizePreset(data.preset)) console.warn(`[conductor] unusable preset ${JSON.stringify(data.preset)}; using "${preset}" from the vibe`);
    const arrangement = sanitizeArrangement(data.sections, data.key);
    return { bpm, key: data.key, timeSignature, preset, arrangement, why: sayPreset(data.why, preset), latencyMs, ...(tokens ? { tokens } : {}) };
  } catch (err) {
    const d = defaultConductor(vibe, overrides);
    console.error(`[conductor] FALLBACK (defaults: ${d.bpm} BPM, ${d.key}, ${d.timeSignature}, ${d.preset}) because: ${(err as Error).message}`);
    const spent = err instanceof AgentError ? err.usage : undefined;
    return { ...d, arrangement: defaultArrangement(d.key), why: '', latencyMs: Date.now() - started, fallback: true, ...(spent ? { tokens: spent } : {}) };
  }
}

/** The chat line must say which preset was picked. If the model's sentence does not name it, a short suffix does. */
function sayPreset(why: string, preset: SoundPreset): string {
  if (!why.trim()) return why;
  const key = preset === 'futurebass' ? 'future' : preset === 'hiphop' ? 'hip' : preset;
  return new RegExp(key, 'i').test(why) ? why : `${why.trim()} Preset: ${preset}.`;
}

const recallFor = (ctx: Ctx, agent: MemoryAgent): Promise<BandMemoryItem[]> => (ctx ? recall(ctx, agent) : Promise.resolve([]));

/**
 * Live steering: the same conductor, asked to update the settings of a band that is already playing.
 * A meter the listener names outright always wins. If the model fails twice, obvious requests are applied directly (see steerFallback) and anything else changes nothing (empty why).
 */
export async function conductorSteerAgent(vibe: string, current: ConductorSettings, text: string): Promise<ConductorReply> {
  const started = Date.now();
  const user = JSON.stringify({ vibe, current, steer: text, task: 'Apply the listener steering instruction to the current settings.' });
  try {
    const { data, latencyMs, tokens } = await runAgent('conductor-steer', STEER_SYSTEM, user, conductorReplySchema, 'low');
    const timeSignature = explicitMeter(text) ?? data.timeSignature;
    const preset = normalizePreset(data.preset) ?? current.preset;
    // A section the listener names outright always wins; otherwise the model's own reading of the steer.
    const section = sectionFromText(text) ?? sectionNameOf(data.section) ?? undefined;
    return { bpm: data.bpm, key: data.key, timeSignature, preset, ...(section ? { section } : {}), why: sayPreset(data.why, preset), latencyMs, ...(tokens ? { tokens } : {}) };
  } catch (err) {
    const fb = steerFallback(text, current);
    console.error(`[conductor-steer] FALLBACK (${fb.why ? 'rules' : 'no change'}) because: ${(err as Error).message}`);
    const spent = err instanceof AgentError ? err.usage : undefined;
    return { ...fb, latencyMs: Date.now() - started, fallback: true, ...(spent ? { tokens: spent } : {}) };
  }
}

export async function drumsAgent(state: JamState, ctx?: Ctx, plan?: BlockPlan): Promise<AgentReply<DrumBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    ...planView(plan, 'drums'),
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

export async function bassAgent(state: JamState, drums: DrumBar[], ctx?: Ctx, plan?: BlockPlan): Promise<AgentReply<BassBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    ...planView(plan, 'bass'),
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

export async function keysAgent(state: JamState, drums: DrumBar[], bass: BassBar[], ctx?: Ctx, plan?: BlockPlan): Promise<AgentReply<ChordBar>> {
  const m = meterOf(state.timeSignature);
  const user = JSON.stringify({
    song: song(state, m),
    ...planView(plan, 'keys'),
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

/** The vox style the block is written for (from its preset; the default preset's style when none was sent) and the windows that belong to the vox in it. */
function voxPlanOf(plan: BlockPlan | undefined, stepsPerBar: number): { style: VoxStyle; windows: VoxWindow[] } {
  const style = plan?.preset && isSoundPreset(plan.preset) ? VOX_STYLE[plan.preset] : VOX_STYLE.lofi;
  return { style, windows: plan ? voxWindows(style, plan.section, stepsPerBar) : [] };
}

export async function melodyAgent(state: JamState, drums: DrumBar[], bass: BassBar[], keys: ChordBar[], ctx?: Ctx, plan?: BlockPlan): Promise<AgentReply<MelodyBar>> {
  const m = meterOf(state.timeSignature);
  const { windows } = voxPlanOf(plan, m.stepsPerBar);
  const user = JSON.stringify({
    song: song(state, m),
    ...planView(plan, 'melody'),
    drums_next_4_bars: drumsView(drums),
    bass_next_4_bars: bass,
    keys_next_4_bars: keys,
    previous_melody_bars: history(state, 'melody'),
    ...(windows.length ? { rest_for_vox: windows.map((w) => ({ bar: w.bar + 1, steps: `${w.from}-${w.to - 1}` })) } : {}),
    band_memory: await recallFor(ctx, 'melody'),
    task: 'Write the next 4 bars of melody over the chords, bass and drums above.',
  });
  return guarded<MelodyBar>(
    'melody',
    ctx,
    async () => {
      const out = await runAgent('melody', melodySystem(m), user, melodyReplySchema(m.stepsPerBar));
      // The vox's windows are left empty whatever the model wrote.
      return { ...out, data: { ...out.data, bars: shapeMelody(out.data.bars, windows) } };
    },
    () => {
      const previous = previousMelody(state);
      return { bars: shapeMelody(previous ?? defaultMelody(state.key), windows), source: previous ? 'previous block' : 'built-in pattern' };
    },
  );
}

export async function voxAgent(state: JamState, drums: DrumBar[], keys: ChordBar[], melody: MelodyBar[], ctx?: Ctx, plan?: BlockPlan): Promise<AgentReply<VoxBar>> {
  const m = meterOf(state.timeSignature);
  const { style, windows } = voxPlanOf(plan, m.stepsPerBar);
  // Nothing to ask when the vox has no window in this block (the whole intro, a rock build, a style's quiet bars): no model call, no tokens, nothing remembered.
  if (!plan || !windows.length) {
    console.log(`[vox] section=${plan?.section ?? '-'} style=${style} no window: silent`);
    return { why: '', bars: silentVox(), latencyMs: 0 };
  }
  const reg = voxRegisterFor(style, melody);
  const view = planView(plan, 'vox') as { section?: { what_to_play?: string } };
  if (view.section) view.section.what_to_play = VOX_SECTION[style][plan.section];
  const user = JSON.stringify({
    song: song(state, m),
    ...view,
    vox_style: { name: style, brief: VOX_BRIEF[style] },
    your_windows: windows.map((w) => ({ bar: w.bar + 1, steps: `${w.from}-${w.to - 1}` })),
    register: { lowest: nameOf(reg.low), highest: nameOf(reg.high) },
    drums_next_4_bars: drumsView(drums),
    keys_next_4_bars: keys,
    melody_next_4_bars: melody,
    previous_vox_bars: history(state, 'vox'),
    band_memory: await recallFor(ctx, 'vox'),
    task: 'Write the next 4 bars of robot vocal chops: only inside your windows, in your register, answering the melody.',
  });
  const fit = (bars: VoxBar[]) => conformVox(bars, { section: plan.section, style, stepsPerBar: m.stepsPerBar, melody });
  const reply = await guarded<VoxBar>(
    'vox',
    ctx,
    async () => {
      const out = await runAgent('vox', voxSystem(m, style), user, voxReplySchema(m.stepsPerBar));
      // Windows, register and limits are enforced whatever the model wrote. If that leaves nothing in a window it should have used, the melody is chopped instead.
      let bars = fit(out.data.bars);
      if (!bars.some((b) => b.length)) bars = fit(chopMelody(melody, m.stepsPerBar, plan.section, style));
      return { ...out, data: { ...out.data, bars } };
    },
    () => {
      const previous = previousVox(state);
      const bars = fit(previous && previous.some((b) => b.length) ? previous : chopMelody(melody, m.stepsPerBar, plan.section, style));
      return { bars, source: 'melody chops' };
    },
  );
  // One line per block so a quiet vox is easy to explain: the style, the section, how many chops each bar got and whether they came from the model.
  console.log(`[vox] section=${plan.section} style=${style} windows=${JSON.stringify(windows.map((w) => [w.bar + 1, w.from, w.to - 1]))} hits/bar=${JSON.stringify(reply.bars.map((b) => b.length))} ${reply.fallback ? 'FALLBACK' : 'model'} ${reply.latencyMs}ms`);
  return reply;
}
