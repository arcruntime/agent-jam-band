/**
 * What the band plays when an agent fails twice: its own previous block (transposed if the key moved), or a plain built-in pattern if there is no previous block yet.
 * Nothing here is ever shown in the UI; the callers log to the server console only.
 */
import { TIME_SIGNATURES, type Meter, type TimeSignature } from '../shared/meter.js';
import { SOUND_PRESETS, type SoundPreset } from '../shared/presets.js';
import type { BassBar, ChordBar, ConductorOverrides, ConductorSettings, DrumBar, JamBar, JamState, MelodyBar } from '../shared/types.js';

// ---------- Pitch helpers ----------

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Pitch class (0-11) of a key's tonic: "F# dorian" -> 6. Falls back to A. */
export function tonicOf(key: string): number {
  const m = /^\s*([A-G])([#b]?)/.exec(key);
  if (!m) return 9;
  return (PITCH_CLASS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

export const isMinorKey = (key: string) => /minor|dorian|phrygian|locrian/i.test(key);

/** Shortest move from one key's tonic to another's, in semitones (-6 .. +5). */
export function semitoneShift(fromKey: string, toKey: string): number {
  const d = (((tonicOf(toKey) - tonicOf(fromKey)) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

function midiOf(note: string): number | null {
  const m = /^([A-G])([#b]?)(\d)$/.exec(note);
  if (!m) return null;
  return (Number(m[3]) + 1) * 12 + PITCH_CLASS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

const nameOf = (midi: number) => `${SHARP_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
const lowestMidi = (octave: number) => (octave + 1) * 12;
const highestMidi = (octave: number) => (octave + 1) * 12 + 11;

/** Move midi notes by whole octaves (together) until they sit inside octaves lo..hi. */
function fold(midis: number[], lo: number, hi: number): number[] {
  let out = midis;
  while (Math.max(...out) > highestMidi(hi) && Math.min(...out) - 12 >= lowestMidi(0)) out = out.map((n) => n - 12);
  while (Math.min(...out) < lowestMidi(lo) && Math.max(...out) + 12 <= highestMidi(8)) out = out.map((n) => n + 12);
  return out;
}

function transposeNames(notes: string[], shift: number, lo: number, hi: number): string[] {
  const midis = notes.map((n) => midiOf(n));
  if (shift === 0 || midis.some((m) => m === null)) return notes;
  return fold((midis as number[]).map((m) => m + shift), lo, hi).map(nameOf);
}

const transposeBass = (bar: BassBar, shift: number): BassBar =>
  bar.map((n) => ({ ...n, note: transposeNames([n.note], shift, 1, 3)[0] }));
const transposeKeys = (bar: ChordBar, shift: number): ChordBar =>
  bar.map((c) => ({ ...c, notes: transposeNames(c.notes, shift, 2, 5) }));
const transposeMelody = (bar: MelodyBar, shift: number): MelodyBar =>
  bar.map((n) => ({ ...n, note: transposeNames([n.note], shift, 4, 6)[0] }));

// ---------- Previous block ----------

/** The last four finished bars of one part, each with the bar it came from. Null if fewer than four exist. */
function lastFour<T>(state: JamState, pick: (b: JamBar) => T | null): { value: T; bar: JamBar }[] | null {
  // Only bars written in the current meter qualify: after a live meter change the older bars have a different step grid.
  const found = state.bars.filter((b) => !b.timeSignature || b.timeSignature === state.timeSignature).flatMap((bar) => {
    const value = pick(bar);
    return value ? [{ value, bar }] : [];
  });
  return found.length >= 4 ? found.slice(-4) : null;
}

const shiftFor = (bar: JamBar, state: JamState) => (bar.key && bar.key !== state.key ? semitoneShift(bar.key, state.key) : 0);

export const previousDrums = (state: JamState): DrumBar[] | null => lastFour(state, (b) => b.drums)?.map((x) => x.value) ?? null;
export const previousBass = (state: JamState): BassBar[] | null =>
  lastFour(state, (b) => b.bass)?.map((x) => transposeBass(x.value, shiftFor(x.bar, state))) ?? null;
export const previousKeys = (state: JamState): ChordBar[] | null =>
  lastFour(state, (b) => b.keys)?.map((x) => transposeKeys(x.value, shiftFor(x.bar, state))) ?? null;
export const previousMelody = (state: JamState): MelodyBar[] | null =>
  lastFour(state, (b) => b.melody)?.map((x) => transposeMelody(x.value, shiftFor(x.bar, state))) ?? null;

/** Make sure every bar with a kick has a bass note on its first kick step, like the bass agent's own rule. */
export function lockBassToKick(bars: BassBar[], drums: DrumBar[], key: string): BassBar[] {
  const root = nameOf(lowestMidi(2) + tonicOf(key));
  return bars.map((bar, b) => {
    const k = drums[b]?.kick.indexOf(1) ?? -1;
    if (k < 0 || bar.some((n) => n.step === k)) return bar;
    return [...bar, { step: k, note: root, dur: '8n' }].sort((x, y) => x.step - y.step);
  });
}

// ---------- Built-in patterns (no previous block yet) ----------

export function defaultDrums(m: Meter): DrumBar[] {
  const a = m.accentSteps;
  const fourGroups = a.length >= 4;
  const kicks = fourGroups ? [a[0], a[2]] : [a[0]];
  const snares = fourGroups ? [a[1], a[3]] : a.slice(1);
  const row = (steps: number[]) => Array.from({ length: m.stepsPerBar }, (_, i) => (steps.includes(i) ? 1 : 0));
  const hats = Array.from({ length: m.stepsPerBar }, (_, i) => i).filter((i) => i % 2 === 0);
  return Array.from({ length: 4 }, () => ({ kick: row(kicks), snare: row(snares), hat: row(hats) }));
}

export function defaultBass(key: string, drums: DrumBar[]): BassBar[] {
  const root = nameOf(lowestMidi(2) + tonicOf(key));
  return drums.map((d) => {
    const kicks = d.kick.flatMap((v, i) => (v ? [i] : []));
    return (kicks.length ? kicks : [0]).map((step) => ({ step, note: root, dur: '8n' }));
  });
}

function triad(key: string, octave: number): string[] {
  const root = lowestMidi(octave) + tonicOf(key);
  return [root, root + (isMinorKey(key) ? 3 : 4), root + 7].map(nameOf);
}

export const defaultKeys = (key: string): ChordBar[] => Array.from({ length: 4 }, () => [{ step: 0, notes: triad(key, 3), dur: '1m' }]);

export function defaultMelody(key: string): MelodyBar[] {
  const [root, third, fifth] = triad(key, 5);
  return [root, fifth, root, third].map((note) => [{ step: 0, note, dur: '2n' }]);
}

// ---------- Conductor defaults ----------

const GENRE_DEFAULTS: Record<SoundPreset, { bpm: number; key: string }> = {
  lofi: { bpm: 85, key: 'A minor' },
  futurebass: { bpm: 145, key: 'F minor' },
  house: { bpm: 124, key: 'A minor' },
  rock: { bpm: 120, key: 'E minor' },
  ambient: { bpm: 70, key: 'D minor' },
};

/** The sound preset a piece of text names (a genre or a mood), or null when it names none. */
export function matchPreset(text: string): SoundPreset | null {
  if (/future\s*bass|dubstep|trap|\bedm\b|synthwave|hyperpop|electro|festival/i.test(text)) return 'futurebass';
  if (/house|techno|disco|dance|club|garage|trance/i.test(text)) return 'house';
  if (/rock|punk|metal|grunge|indie|funk|blues|guitar/i.test(text)) return 'rock';
  if (/ambient|drone|cinematic|new age|sleep|meditat|space|drift/i.test(text)) return 'ambient';
  if (/lo-?fi|jazz|bossa|chill|hip.?hop|boom bap|soul|study/i.test(text)) return 'lofi';
  return null;
}

/** Best-guess sound preset from the vibe text. Lo-fi when nothing matches. */
export function presetFromVibe(vibe: string): SoundPreset {
  return matchPreset(vibe) ?? 'lofi';
}

/** Accepts "lofi", "Lo-Fi", "future bass" ... and returns a real preset name, or null. */
export function normalizePreset(raw: unknown): SoundPreset | null {
  const v = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z]/g, '') : '';
  return (SOUND_PRESETS as readonly string[]).includes(v) ? (v as SoundPreset) : null;
}

export function defaultConductor(vibe: string, overrides: ConductorOverrides) {
  const preset = presetFromVibe(vibe);
  const g = GENRE_DEFAULTS[preset];
  return { bpm: overrides.bpm ?? g.bpm, key: g.key, timeSignature: overrides.timeSignature ?? ('4/4' as const), preset };
}


// ---------- Live steering ----------

/** A meter the steer text names outright ("7/8", "switch to 5/4"), or null. */
export function explicitMeter(text: string): TimeSignature | null {
  const found = text.match(/\b[3-7]\s*\/\s*[48]\b/g)?.map((m) => m.replace(/\s+/g, ''));
  return (found?.find((m) => (TIME_SIGNATURES as readonly string[]).includes(m)) as TimeSignature | undefined) ?? null;
}

const METER_HINT: Record<TimeSignature, string> = {
  '4/4': 'straight four on the floor',
  '3/4': 'a waltz feel, one-two-three',
  '5/4': 'think odd grouping 3+2',
  '7/8': 'think odd grouping 2+2+3',
  '6/8': 'think two groups of three',
};

/** One step darker: major-ish keys go minor, dorian goes minor, minor goes phrygian. */
const darkerKey = (key: string): string => {
  const tonic = /^\s*([A-G][#b]?)/.exec(key)?.[1] ?? 'A';
  if (/major|lydian|mixolydian|dorian/i.test(key)) return `${tonic} minor`;
  if (/minor/i.test(key)) return `${tonic} phrygian`;
  return key;
};

/**
 * What a steer does when the conductor model cannot be reached or fails twice: obvious requests (a meter, half-time, drop, darker, a genre) are applied directly, anything else changes nothing.
 * An empty `why` means there was nothing to do, and the client then ignores the steer.
 */
export function steerFallback(text: string, current: ConductorSettings): ConductorSettings & { why: string } {
  const next: ConductorSettings = { ...current };
  const notes: string[] = [];
  const meter = explicitMeter(text);
  if (meter && meter !== current.timeSignature) {
    next.timeSignature = meter;
    notes.push(`Switching to ${meter}: drums, ${METER_HINT[meter]}.`);
  }
  const genre = matchPreset(text);
  if (genre && /genre|style|make it|switch|go|play/i.test(text) && genre !== current.preset) {
    next.preset = genre;
    next.bpm = overridesSafeBpm(GENRE_DEFAULTS[genre].bpm);
    next.key = GENRE_DEFAULTS[genre].key;
    notes.push(`Changing genre to ${genre}: everyone, new tempo and new colors.`);
  }
  if (/half[- ]?time/i.test(text)) notes.push('Half-time feel: drums, snare on beat three and give the groove room.');
  if (/\bdrop\b/i.test(text)) notes.push('The drop: hit hard, heavy kick and bass, keys stab.');
  if (/dark/i.test(text)) {
    next.key = darkerKey(next.key);
    next.bpm = overridesSafeBpm(Math.round(next.bpm * 0.92));
    notes.push('Going darker: lower voicings, minor colors, more space.');
  }
  return { ...next, why: notes.join(' ').split(/\s+/).slice(0, 20).join(' ') };
}

const overridesSafeBpm = (n: number) => Math.min(180, Math.max(60, Math.round(n)));
