import type { BassNote, BlockParts, ChordHit, MelodyNote } from '../shared/types';

export interface StepEvents {
  /** Which bar of the block this step is in (0-3) */
  bar: number;
  /** Step within the bar (0 .. stepsPerBar-1) */
  step: number;
  kick: boolean;
  snare: boolean;
  hat: boolean;
  bass: BassNote[];
  keys: ChordHit[];
  melody: MelodyNote[];
}

/**
 * Everything that sounds on one step of a block. `pos` counts steps from the start of the block, and a bar is `stepsPerBar` steps long, so the grid follows the meter (7/8 = 14 steps per bar, 5/4 = 20, ...).
 */
export function stepEvents(parts: BlockParts, pos: number, stepsPerBar: number): StepEvents {
  const bar = Math.floor(pos / stepsPerBar);
  const step = pos % stepsPerBar;
  const drums = parts.drums[bar];
  return {
    bar,
    step,
    kick: drums.kick[step] === 1,
    snare: drums.snare[step] === 1,
    hat: drums.hat[step] === 1,
    bass: parts.bass[bar].filter((n) => n.step === step),
    keys: parts.keys[bar].filter((c) => c.step === step),
    melody: parts.melody[bar].filter((n) => n.step === step),
  };
}
