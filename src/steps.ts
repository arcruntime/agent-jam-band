import type { BlockParts } from '../shared/types';

/** Strength used when an agent leaves "velocity" out. */
export const DEFAULT_VELOCITY = 0.8;
/** Multiplier for anything that lands on a strong beat (beats 1 and 3). */
export const ACCENT_BOOST = 1.15;
/** A hat on an off-sixteenth with no velocity of its own is a ghost note at this fraction of the default. */
export const GHOST_HAT = 0.5;

/** A note or chord hit with its final strength (0-1). */
export type Played<T> = T & { velocity: number };

export interface StepEvents {
  /** Which bar of the block this step is in (0-3) */
  bar: number;
  /** Step within the bar (0 .. stepsPerBar-1) */
  step: number;
  /** Drum strength 0-1, or 0 when the instrument does not play on this step */
  kick: number;
  snare: number;
  hat: number;
  bass: Played<BlockParts['bass'][number][number]>[];
  keys: Played<BlockParts['keys'][number][number]>[];
  melody: Played<BlockParts['melody'][number][number]>[];
  vox: Played<BlockParts['vox'][number][number]>[];
}

/**
 * The steps that count as "beats 1 and 3" for a meter, from its group start steps: 4/4 gives [0, 8], 3/4 [0, 8], 7/8 [0, 8], and the two-group meters 5/4 and 6/8 accent both of their groups ([0, 12] and [0, 6]).
 */
export function strongSteps(groupStarts: readonly number[]): number[] {
  return groupStarts.length >= 3 ? [groupStarts[0], groupStarts[2]] : [...groupStarts];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0.05, v));

/**
 * Everything that sounds on one step of a block, with a strength for each event. `pos` counts steps from the start of the block, and a bar is `stepsPerBar` steps long, so the grid follows the meter (7/8 = 14 steps per bar, 5/4 = 20, ...).
 * Strength is the agent's own velocity (0.8 when missing), lifted on strong beats; hats that fall on an odd sixteenth and have no velocity of their own become quiet ghost notes.
 */
export function stepEvents(parts: BlockParts, pos: number, stepsPerBar: number, strong: readonly number[] = [0]): StepEvents {
  const bar = Math.floor(pos / stepsPerBar);
  const step = pos % stepsPerBar;
  const drums = parts.drums[bar];
  const accent = strong.includes(step) ? ACCENT_BOOST : 1;
  const strength = (v: number | undefined) => clamp01((v ?? DEFAULT_VELOCITY) * accent);

  const drum = (row: 'kick' | 'snare' | 'hat') => {
    if (drums[row][step] !== 1) return 0;
    const given = drums.velocity?.[row]?.[step];
    if (row === 'hat' && given === undefined && step % 2 === 1) return clamp01(DEFAULT_VELOCITY * GHOST_HAT * accent);
    return strength(given);
  };

  const played = <T extends { step: number; velocity?: number }>(list: T[]): Played<T>[] =>
    list.filter((n) => n.step === step).map((n) => ({ ...n, velocity: strength(n.velocity) }));

  return {
    bar,
    step,
    kick: drum('kick'),
    snare: drum('snare'),
    hat: drum('hat'),
    bass: played(parts.bass[bar]),
    keys: played(parts.keys[bar]),
    melody: played(parts.melody[bar]),
    vox: played(parts.vox?.[bar] ?? []),
  };
}
