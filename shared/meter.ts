/** Meter helpers shared by the backend (prompts, validation) and the frontend (transport, step grid). */

export const TIME_SIGNATURES = ['4/4', '3/4', '5/4', '7/8', '6/8'] as const;
export type TimeSignature = (typeof TIME_SIGNATURES)[number];

export function isTimeSignature(value: unknown): value is TimeSignature {
  return typeof value === 'string' && (TIME_SIGNATURES as readonly string[]).includes(value);
}

/** Steps in each felt group of the bar (a step is a sixteenth note) and a plain-words description of the feel. */
const SPECS: Record<TimeSignature, { groups: number[]; feel: string }> = {
  '4/4': { groups: [4, 4, 4, 4], feel: 'four quarter-note beats' },
  '3/4': { groups: [4, 4, 4], feel: 'three quarter-note beats' },
  '5/4': { groups: [12, 8], feel: 'five quarter-note beats grouped 3+2' },
  '7/8': { groups: [4, 4, 6], feel: 'seven eighth notes grouped 2+2+3' },
  '6/8': { groups: [6, 6], feel: 'six eighth notes grouped 3+3 (two big beats)' },
};

export interface Meter {
  timeSignature: TimeSignature;
  numerator: number;
  denominator: number;
  /** Sixteenth-note steps in one bar: 4/4 = 16, 3/4 = 12, 5/4 = 20, 7/8 = 14, 6/8 = 12 */
  stepsPerBar: number;
  /** Steps where each felt group of the bar starts */
  accentSteps: number[];
  description: string;
}

export function meterOf(timeSignature: TimeSignature): Meter {
  const [numerator, denominator] = timeSignature.split('/').map(Number);
  const { groups, feel } = SPECS[timeSignature];
  const accentSteps: number[] = [];
  let at = 0;
  for (const g of groups) {
    accentSteps.push(at);
    at += g;
  }
  const stepsPerBar = (numerator * 16) / denominator;
  return {
    timeSignature,
    numerator,
    denominator,
    stepsPerBar,
    accentSteps,
    description: `${timeSignature} time with ${stepsPerBar} sixteenth-note steps per bar (a quarter note is 4 steps, an eighth note is 2 steps). Step 0 is the downbeat. The bar is felt as ${feel}; the groups start at steps ${accentSteps.join(', ')}.`,
  };
}
