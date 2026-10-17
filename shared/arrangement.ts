/**
 * Song structure, shared by the server (conductor, agents, band memory) and the browser (playback and the header). Pure functions only, no imports, so both sides can use it as is.
 * The conductor plans an arrangement of sections (intro, build, drop, breakdown), each with a chord progression that repeats to give one chord per bar. The song is cut into 4-bar blocks, and every block belongs to exactly one section.
 */

export const SECTION_NAMES = ['intro', 'build', 'drop', 'breakdown'] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

/** A block is four bars, and section lengths are always a multiple of it, so a block never straddles two sections. */
export const BLOCK_BARS = 4;
export const MAX_SONG_BARS = 64;
const MAX_SECTION_BARS = 32;
const MAX_CHORDS = 8;

export interface ArrangementSection {
  name: SectionName;
  bars: number;
  /** Chord symbols that repeat over the section's bars: with 4 chords over 8 bars the progression plays twice. */
  chords: string[];
}

export interface Arrangement {
  sections: ArrangementSection[];
}

/** What one musician is told about the block it is writing: where it sits in its section and the chord of each of its 4 bars. */
export interface BlockPlan {
  section: SectionName;
  /** The section bar (1-based) this block starts on */
  sectionBar: number;
  sectionBars: number;
  chords: string[];
}

/** One block of the arrangement, in song order. */
export interface BlockSlot extends BlockPlan {
  /** Which entry of the arrangement's sections this block belongs to (a song can have two drops) */
  sectionIndex: number;
}

export const DEFAULT_LAYOUT: readonly [SectionName, number][] = [
  ['intro', 8],
  ['build', 8],
  ['drop', 16],
  ['breakdown', 8],
  ['drop', 16],
];

// ---------- Chords ----------

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Chord qualities as semitones above the root. */
const QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  '9': [0, 4, 7, 10, 2],
  maj9: [0, 4, 7, 11, 2],
  m9: [0, 3, 7, 10, 2],
  add9: [0, 4, 7, 2],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8],
};

const CHORD_RE = new RegExp(`^([A-G][#b]?)(${Object.keys(QUALITIES).filter(Boolean).sort((a, b) => b.length - a.length).join('|')})?$`);

const flatSpelling = (root: string) => root.includes('b') || root === 'F';

/** A chord symbol as its root and its tones (pitch names without octave, root first), or null if it is not a chord this app knows. "Am7" gives A, C, E, G. */
export function parseChord(symbol: unknown): { symbol: string; root: string; tones: string[] } | null {
  if (typeof symbol !== 'string') return null;
  const text = symbol.trim();
  const m = CHORD_RE.exec(text);
  if (!m) return null;
  const rootPc = (PITCH_CLASS[m[1][0]] + (m[1][1] === '#' ? 1 : m[1][1] === 'b' ? -1 : 0) + 12) % 12;
  const names = flatSpelling(m[1]) ? FLATS : SHARPS;
  const tones = QUALITIES[m[2] ?? ''].map((i) => names[(rootPc + i) % 12]);
  return { symbol: text, root: tones[0], tones };
}

// ---------- Progressions from a key ----------

type Degree = [semitones: number, minor: boolean];

/** Four-chord loops by mode family: i-VI-III-VII, I-V-vi-IV and so on. */
const LOOPS: Record<string, Degree[]> = {
  minor: [[0, true], [8, false], [3, false], [10, false]],
  major: [[0, false], [7, false], [9, true], [5, false]],
  dorian: [[0, true], [5, false], [3, false], [10, false]],
  phrygian: [[0, true], [1, false], [0, true], [10, false]],
  lydian: [[0, false], [2, false], [0, false], [7, false]],
  mixolydian: [[0, false], [10, false], [5, false], [0, false]],
};

const FLAT_DEGREES = [1, 3, 8, 10];

function family(key: string): string {
  const mode = /(major|minor|dorian|phrygian|lydian|mixolydian|locrian)/i.exec(key)?.[1]?.toLowerCase() ?? 'minor';
  return mode === 'locrian' ? 'minor' : mode;
}

const rotate = <T>(list: T[], by: number) => list.map((_, i) => list[(i + by) % list.length]);

/** A 4-chord progression in the key, a little different for each section (the build starts further round the loop, the breakdown one chord on). */
export function progressionFor(key: string, section: SectionName): string[] {
  const tonic = /^\s*([A-G][#b]?)/.exec(key)?.[1] ?? 'A';
  const tonicPc = (PITCH_CLASS[tonic[0]] + (tonic[1] === '#' ? 1 : tonic[1] === 'b' ? -1 : 0) + 12) % 12;
  const loop = LOOPS[family(key)] ?? LOOPS.minor;
  const shape = section === 'build' ? rotate(loop, 2) : section === 'breakdown' ? rotate(loop, 1) : loop;
  // Spelling: the flat degrees (bII, bIII, bVI, bVII) are written with flats unless the key itself uses sharps, so A phrygian has Bb rather than A#.
  return shape.map(([semitones, minor]) => {
    const flats = flatSpelling(tonic) || (FLAT_DEGREES.includes(semitones) && !tonic.includes('#'));
    return `${(flats ? FLATS : SHARPS)[(tonicPc + semitones) % 12]}${minor ? 'm' : ''}`;
  });
}

// ---------- Arrangements ----------

export function defaultArrangement(key: string): Arrangement {
  return { sections: DEFAULT_LAYOUT.map(([name, bars]) => ({ name, bars, chords: progressionFor(key, name) })) };
}

const ALIASES: Record<string, SectionName> = {
  intro: 'intro',
  introduction: 'intro',
  build: 'build',
  buildup: 'build',
  buildups: 'build',
  drop: 'drop',
  breakdown: 'breakdown',
  break: 'breakdown',
};

/** "Intro", "build-up", "Breakdown" -> the section name, or null for anything else. */
export function sectionNameOf(raw: unknown): SectionName | null {
  const v = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z]/g, '') : '';
  return ALIASES[v] ?? null;
}

/**
 * Turns whatever the conductor model sent into a valid arrangement: unknown section names are skipped, lengths are rounded to whole blocks (4 to 32 bars), chords that are not chords are dropped (a section left without chords gets a progression from the key), and the song is cut at 64 bars. Less than two usable sections gives the default arrangement.
 */
export function sanitizeArrangement(raw: unknown, key: string): Arrangement {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { sections?: unknown }).sections) ? (raw as { sections: unknown[] }).sections : null;
  if (!list) return defaultArrangement(key);
  const sections: ArrangementSection[] = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { name?: unknown; bars?: unknown; chords?: unknown };
    const name = sectionNameOf(entry.name);
    if (!name) continue;
    const asked = Math.round(Number(entry.bars) / BLOCK_BARS) * BLOCK_BARS;
    const bars = Number.isFinite(asked) ? Math.min(MAX_SECTION_BARS, Math.max(BLOCK_BARS, asked)) : BLOCK_BARS;
    if (total + bars > MAX_SONG_BARS) break;
    const chords = (Array.isArray(entry.chords) ? entry.chords : [])
      .flatMap((c) => {
        const chord = parseChord(c);
        return chord ? [chord.symbol] : [];
      })
      .slice(0, MAX_CHORDS);
    sections.push({ name, bars, chords: chords.length ? chords : progressionFor(key, name) });
    total += bars;
  }
  return sections.length >= 2 ? { sections } : defaultArrangement(key);
}

/** The same sections and lengths with new chords for a new key (a live steer moved the key, and the old chords would clash). */
export function reharmonize(a: Arrangement, key: string): Arrangement {
  return { sections: a.sections.map((s) => ({ ...s, chords: progressionFor(key, s.name) })) };
}

/** The song as a list of 4-bar blocks, each with the chord of each of its bars. */
export function slotsOf(a: Arrangement): BlockSlot[] {
  const slots: BlockSlot[] = [];
  a.sections.forEach((s, sectionIndex) => {
    for (let bar = 0; bar < s.bars; bar += BLOCK_BARS) {
      slots.push({
        section: s.name,
        sectionIndex,
        sectionBar: bar + 1,
        sectionBars: s.bars,
        chords: Array.from({ length: BLOCK_BARS }, (_, i) => s.chords[(bar + i) % s.chords.length]),
      });
    }
  });
  return slots;
}

/** The first block (from `from` onwards, wrapping round the loop) that starts a section called `name`, or null if the song has none. */
export function sectionStart(slots: BlockSlot[], name: SectionName, from: number): number | null {
  for (let i = 0; i < slots.length; i++) {
    const at = (from + i) % slots.length;
    if (slots[at].section === name && slots[at].sectionBar === 1) return at;
  }
  return null;
}

const STEER_WORDS = /\b(break\s*down|breakdown|build\s*-?\s*ups?|build|drop|intro)\b/i;

/** A song section a steer names outright ("drop", "go to the breakdown", "build up"), or null. */
export function sectionFromText(text: string): SectionName | null {
  const word = STEER_WORDS.exec(text)?.[1];
  return word ? sectionNameOf(word.replace(/[\s-]+/g, '').replace(/ups?$/, 'up')) : null;
}

/** "intro 8 · build 8 · drop 16", for the chat. */
export function describeArrangement(a: Arrangement): string {
  return a.sections.map((s) => `${s.name} ${s.bars}`).join(' · ');
}
