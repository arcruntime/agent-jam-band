/**
 * How the vox behaves in each genre, shared by the server (what to ask for and what to keep) and the browser (how it sounds).
 *
 *   stab:    futurebass, house, dnb. Bright pitched stabs one octave above the melody, short "ah" and "oh" chops on off-beats and syncopations, light bitcrush for glitch.
 *   vocoder: hiphop, lofi. A robot voice below the melody, sustained vowels on chord tones, warm and a little crushed, sparse call phrases.
 *   pad:     jazz, ambient. Soft "oo" pads or very sparse airy chops above the melody, no crush.
 *   rare:    rock. Mostly rests; a rare airy chop at the end of a drop.
 *
 * The vox and the melody trade phrases: each style has "windows" (a bar and a range of steps in it) where only the vox plays and the melody rests. The same windows are given to the melody agent and enforced on both parts, so the two never talk at once.
 */
import type { SectionName } from './arrangement.js';
import type { SoundPreset } from './presets.js';

export type VoxStyle = 'stab' | 'vocoder' | 'pad' | 'rare';

export const VOX_STYLE: Record<SoundPreset, VoxStyle> = {
  futurebass: 'stab',
  house: 'stab',
  dnb: 'stab',
  hiphop: 'vocoder',
  lofi: 'vocoder',
  jazz: 'pad',
  ambient: 'pad',
  rock: 'rare',
};

/** A stretch of one bar (0-based) that belongs to the vox: steps from..to-1. */
export interface VoxWindow {
  bar: number;
  from: number;
  to: number;
}

/** [bar 0-3, start fraction of the bar, end fraction of the bar] */
type Span = [number, number, number];

const WINDOWS: Record<VoxStyle, Record<SectionName, Span[]>> = {
  // Builds: a tease that grows (the last quarter of bars 2 and 3, the last half of bar 4). Drops: melody takes bars 1 and 2, the vox answers on bars 3 and 4 (the melody keeps the downbeat).
  stab: { intro: [], build: [[1, 0.75, 1], [2, 0.75, 1], [3, 0.5, 1]], drop: [[2, 0.25, 1], [3, 0.25, 1]], breakdown: [[3, 0.5, 1]] },
  // Call phrases only: the second half of bars 2 and 4 in a drop.
  vocoder: { intro: [], build: [[2, 0.5, 1], [3, 0.5, 1]], drop: [[1, 0.5, 1], [3, 0.5, 1]], breakdown: [[3, 0, 0.5]] },
  pad: { intro: [], build: [[3, 0, 1]], drop: [[3, 0, 1]], breakdown: [[3, 0, 0.5]] },
  rare: { intro: [], build: [], drop: [[3, 0.5, 1]], breakdown: [] },
};

export function voxWindows(style: VoxStyle, section: SectionName, stepsPerBar: number): VoxWindow[] {
  return WINDOWS[style][section]
    .map(([bar, a, b]) => ({ bar, from: Math.round(a * stepsPerBar), to: Math.round(b * stepsPerBar) }))
    .filter((w) => w.to > w.from);
}

/** The most chops a bar may hold and the loudest velocity, by style and section. The vox bus itself sits under the melody's, so these are about density and feel, not the mix. */
export const VOX_LIMITS: Record<VoxStyle, Record<SectionName, { hits: number; velocity: number }>> = {
  stab: { intro: { hits: 0, velocity: 0 }, build: { hits: 3, velocity: 0.65 }, drop: { hits: 6, velocity: 0.8 }, breakdown: { hits: 1, velocity: 0.5 } },
  vocoder: { intro: { hits: 0, velocity: 0 }, build: { hits: 2, velocity: 0.6 }, drop: { hits: 3, velocity: 0.7 }, breakdown: { hits: 1, velocity: 0.5 } },
  pad: { intro: { hits: 0, velocity: 0 }, build: { hits: 1, velocity: 0.5 }, drop: { hits: 2, velocity: 0.55 }, breakdown: { hits: 1, velocity: 0.45 } },
  rare: { intro: { hits: 0, velocity: 0 }, build: { hits: 0, velocity: 0 }, drop: { hits: 2, velocity: 0.55 }, breakdown: { hits: 0, velocity: 0 } },
};

/** Where the vox may sing (MIDI numbers), from the middle of the melody's own range: never the same register as the melody. */
export function voxRegister(style: VoxStyle, melodyMedian: number): { low: number; high: number } {
  const m = Math.round(melodyMedian);
  switch (style) {
    case 'stab': {
      const low = Math.min(m + 10, 84);
      return { low, high: Math.min(Math.max(m + 22, low + 11), 96) };
    }
    case 'vocoder': {
      const high = Math.max(m - 9, 52);
      return { low: Math.max(high - 13, 40), high };
    }
    default: {
      const low = Math.min(m + 4, 80);
      return { low, high: Math.min(low + 12, 96) };
    }
  }
}

/** Shift a MIDI note by whole octaves into the register. */
export function fitRegister(midi: number, reg: { low: number; high: number }): number {
  let m = midi;
  while (m < reg.low) m += 12;
  while (m > reg.high) m -= 12;
  return m;
}

/** What each style sounds like, for the model (the section-specific part is VOX_SECTION). */
export const VOX_BRIEF: Record<VoxStyle, string> = {
  stab: 'Bright pitched vocal stabs, in the style of an EDM producer chopping a vocal: very short "ah" and "oh" chops (mostly "16n", sometimes "8n"), high in the register given below, landing on off-beats and syncopations, never on the downbeat. Each stab answers the melody\'s phrase.',
  vocoder: 'A vocoder-style robot voice: sustained vowels ("2n" or "4n") that follow the chord tones of the bar, low in the register given below, warm and soft. Sparse call phrases of one or two notes, never a busy line. Use "ah", "oh" and "oo".',
  pad: 'A soft airy pad: one or two held "oo" vowels (sometimes "oh"), "2n" or longer, on chord tones, high in the register given below. Very sparse; rests are normal.',
  rare: 'Almost always silent. In a drop, at the very end of the phrase, one or two airy held "oo" vowels on a chord tone, high in the register given below.',
};

export const VOX_SECTION: Record<VoxStyle, Record<SectionName, string>> = {
  stab: {
    intro: 'silent',
    build: 'tease: a few quiet stabs inside your windows only (they get busier toward the end of the build, and the sound opens up with a rising filter)',
    drop: 'answer the melody: the melody plays bars 1 and 2 and you answer in your windows on bars 3 and 4, 3 to 6 stabs a bar',
    breakdown: 'one quiet chop, or nothing',
  },
  vocoder: {
    intro: 'silent',
    build: 'one or two soft held vowels at the end of bars 3 and 4',
    drop: 'call phrases: one to three held vowels in the second half of bars 2 and 4, answering the melody',
    breakdown: 'one soft held vowel',
  },
  pad: {
    intro: 'silent',
    build: 'one held vowel in bar 4',
    drop: 'one or two held vowels in bar 4',
    breakdown: 'one soft held vowel',
  },
  rare: {
    intro: 'silent',
    build: 'silent',
    drop: 'one or two airy vowels at the very end of bar 4, or nothing',
    breakdown: 'silent',
  },
};
