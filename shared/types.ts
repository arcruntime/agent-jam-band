/** Types shared by the Express backend and the Vite frontend. */
import type { TimeSignature } from './meter.js';
import type { SoundPreset } from './presets.js';

export type { TimeSignature };

/** One bar of drums on the step grid: each row has stepsPerBar values, 0 or 1. */
export interface DrumBar {
  kick: number[];
  snare: number[];
  hat: number[];
  /** Optional strength (0-1) of the hit on each step, per row. Missing means the default of 0.8. */
  velocity?: { kick?: number[]; snare?: number[]; hat?: number[] };
}

export interface BassNote {
  /** 0 .. stepsPerBar-1 on the sixteenth-note grid */
  step: number;
  /** Scientific pitch, e.g. "A2" */
  note: string;
  /** Tone.js duration, e.g. "8n" ("1m" = one bar) */
  dur: string;
  /** Optional strength 0-1; missing means 0.8 */
  velocity?: number;
}

export type BassBar = BassNote[];

export interface ChordHit {
  step: number;
  /** e.g. ["A3", "C4", "E4"] */
  notes: string[];
  dur: string;
  /** Optional strength 0-1; missing means 0.8 */
  velocity?: number;
}

export type ChordBar = ChordHit[];

export type MelodyNote = BassNote;
export type MelodyBar = MelodyNote[];

/** One bar of the shared state. Parts are null until their agent has written them (agents run in order and overlap across blocks). */
export interface JamBar {
  /** The key this bar was written in, so a reused bar can be transposed if the key changes */
  key?: string;
  /** The meter this bar was written in. Bars from another meter are not shown to the agents and never reused, because their step grid has a different length. */
  timeSignature?: TimeSignature;
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
  /** The listener's latest live steer and the conductor's direction for the band. It overrides the vibe wherever the two conflict. */
  steer?: { text: string; direction: string };
}

/** What each musician returns: a one-line note plus 4 bars. */
export interface AgentReply<T> {
  why: string;
  bars: T[];
  /** Server-side time for the whole agent call, retries included */
  latencyMs: number;
  /** True when the agent failed twice and the server reused an earlier block instead (the UI treats this like any other reply) */
  fallback?: boolean;
  /** True when this agent called back an earlier motif, so the graph has a new ECHOES edge to fetch */
  echoed?: boolean;
}

/** Four bars of every part, as played together. */
export interface BlockParts {
  drums: DrumBar[];
  bass: BassBar[];
  keys: ChordBar[];
  melody: MelodyBar[];
}

/** The four things the conductor decides, and what a live steer changes. */
export interface ConductorSettings {
  bpm: number;
  key: string;
  timeSignature: TimeSignature;
  preset: SoundPreset;
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

// ---------- Band memory (Neo4j) ----------

export type GraphNodeType = 'session' | 'block' | 'agent' | 'motif' | 'steer';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** drums | bass | keys | melody, for agent and motif nodes */
  agent?: string;
  /** Block number (1-based), for block and motif nodes */
  block?: number;
  summary?: string;
}

export type GraphLinkType = 'IN_SESSION' | 'IN_BLOCK' | 'PLAYED' | 'ECHOES' | 'LOCKS_TO' | 'CHANGED';

export interface GraphLink {
  source: string;
  target: string;
  type: GraphLinkType;
  /** Why the motif was brought back, for ECHOES links */
  reason?: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  links: GraphLink[];
  /** False when Neo4j is off or unreachable (the lists are then empty) */
  available: boolean;
}
