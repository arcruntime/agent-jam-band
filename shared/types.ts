/** Types shared by the Express backend and the Vite frontend. */

/** One bar of drums on a 16-step grid: each row has 16 values, 0 or 1. */
export interface DrumBar {
  kick: number[];
  snare: number[];
  hat: number[];
}

export interface BassNote {
  /** 0-15 on the 16th-note grid */
  step: number;
  /** Scientific pitch, e.g. "A2" */
  note: string;
  /** Tone.js duration, e.g. "8n" */
  dur: string;
}

export type BassBar = BassNote[];

export interface JamBar {
  drums: DrumBar;
  /** null while the drummer has written this bar but the bassist has not yet */
  bass: BassBar | null;
}

/** Shared state both agents see. `bars` grows by 4 each time the band writes a phrase. */
export interface JamState {
  tempo: number;
  key: string;
  vibe: string;
  bars: JamBar[];
}

/** What each agent returns: a one-line note plus 4 bars. */
export interface AgentReply<T> {
  why: string;
  bars: T[];
  /** Server-side time for the whole agent call, retries included */
  latencyMs: number;
}
