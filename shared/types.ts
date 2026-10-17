/** Types shared by the Express backend and the Vite frontend. */
import type { TimeSignature } from './meter.js';
import type { SoundPreset } from './presets.js';

export type { TimeSignature };

/** One bar of drums on the step grid: each row has stepsPerBar values, 0 or 1. */
export interface DrumBar {
  kick: number[];
  snare: number[];
  hat: number[];
}

export interface BassNote {
  /** 0 .. stepsPerBar-1 on the sixteenth-note grid */
  step: number;
  /** Scientific pitch, e.g. "A2" */
  note: string;
  /** Tone.js duration, e.g. "8n" ("1m" = one bar) */
  dur: string;
}

export type BassBar = BassNote[];

export interface ChordHit {
  step: number;
  /** e.g. ["A3", "C4", "E4"] */
  notes: string[];
  dur: string;
}

export type ChordBar = ChordHit[];

export type MelodyNote = BassNote;
export type MelodyBar = MelodyNote[];

/** One bar of the shared state. Parts are null until their agent has written them (agents run in order and overlap across blocks). */
export interface JamBar {
  /** The key this bar was written in, so a reused bar can be transposed if the key changes */
  key?: string;
  drums: DrumBar;
  bass: BassBar | null;
  keys: ChordBar | null;
  melody: MelodyBar | null;
}

/** Shared state every agent sees. `tempo` is quarter-note beats per minute. `bars` grows by 4 each time the band writes a phrase. */
export interface JamState {
  tempo: number;
  key: string;
  timeSignature: TimeSignature;
  vibe: string;
  bars: JamBar[];
}

/** What each musician returns: a one-line note plus 4 bars. */
export interface AgentReply<T> {
  why: string;
  bars: T[];
  /** Server-side time for the whole agent call, retries included */
  latencyMs: number;
  /** True when the agent failed twice and the server reused an earlier block instead (the UI treats this like any other reply) */
  fallback?: boolean;
}

/** Four bars of every part, as played together. */
export interface BlockParts {
  drums: DrumBar[];
  bass: BassBar[];
  keys: ChordBar[];
  melody: MelodyBar[];
}

export interface ConductorOverrides {
  bpm?: number;
  timeSignature?: TimeSignature;
}

export interface ConductorReply {
  bpm: number;
  key: string;
  timeSignature: TimeSignature;
  /** Sound preset for the synths and effects */
  preset: SoundPreset;
  why: string;
  latencyMs: number;
  fallback?: boolean;
}
