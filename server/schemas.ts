import { z } from 'zod';
import { SECTION_NAMES } from '../shared/arrangement.js';
import { TIME_SIGNATURES } from '../shared/meter.js';

export const BARS = 4;
export const DURATIONS = ['16n', '8n', '8n.', '4n', '4n.', '2n', '2n.', '1n', '1m'] as const;

export const timeSignatureSchema = z.enum(TIME_SIGNATURES);

const bit = z.number().int().min(0).max(1);
export const MAX_EVENTS = 16;
export const MAX_WHY_WORDS = 20;
/** The one-line note is cut to 20 words rather than rejected, so a wordy model never costs a retry. */
const why = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.split(/\s+/).slice(0, MAX_WHY_WORDS).join(' ').slice(0, 200));
/**
 * "echoes": null, or { id, reason } naming a motif from band memory that this phrase calls back. Lenient on purpose (a bare id string, a different key, a missing or odd value all work): a callback is a bonus and never costs a retry.
 */
export interface EchoClaim {
  id: string;
  reason: string;
}
export function parseEcho(value: unknown): EchoClaim | null {
  const raw = typeof value === 'string' ? { id: value } : value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!raw) return null;
  const id = raw.id ?? raw.motif ?? raw.motifId ?? raw.motif_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_:-]{3,140}$/.test(id.trim())) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().split(/\s+/).slice(0, 12).join(' ').slice(0, 120) : '';
  return { id: id.trim(), reason: reason || 'calling it back' };
}
const echoes = z.unknown().optional().transform(parseEcho);
const dur = z.enum(DURATIONS);

/** Optional strength 0-1 per event. Lenient on purpose: out-of-range values are clamped and anything that is not a number is dropped (playback then uses 0.8), so dynamics never cost a retry. */
export function parseVelocity(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
}
const velocity = z.unknown().optional().transform(parseVelocity);

type DrumVelocity = { kick?: number[]; snare?: number[]; hat?: number[] };
function parseDrumVelocity(value: unknown): DrumVelocity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: DrumVelocity = {};
  for (const row of ['kick', 'snare', 'hat'] as const) {
    const list = (value as Record<string, unknown>)[row];
    if (Array.isArray(list)) out[row] = list.slice(0, 32).map((v) => parseVelocity(v) ?? 0.8);
  }
  return Object.keys(out).length ? out : undefined;
}
const drumVelocity = z.unknown().optional().transform(parseDrumVelocity);
const pitch = z.string().regex(/^[A-G][#b]?[0-8]$/, 'pitch must look like "A2" or "C#3"');
const octave = (p: string) => Number(p.slice(-1));
const stepIn = (steps: number) => z.number().int().min(0).max(steps - 1);
const firstOutOfOrder = (items: { step: number }[]) => items.findIndex((n, i) => i > 0 && n.step <= items[i - 1].step);
const ASCENDING = 'steps must be strictly ascending (one entry per step)';

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

// ---------- Parts (all sized by the meter's steps per bar) ----------

export const drumBarSchema = (steps: number) => {
  const row = z.array(bit).length(steps);
  return z.object({ kick: row, snare: row, hat: row, velocity: drumVelocity }).superRefine((bar, ctx) => {
    // The limit is per instrument: kick, snare and hat may each have up to MAX_EVENTS hits in a bar.
    for (const name of ['kick', 'snare', 'hat'] as const) {
      const hits = bar[name].reduce((sum, v) => sum + v, 0);
      if (hits > MAX_EVENTS) ctx.addIssue({ code: 'custom', message: `too many ${name} hits in one bar (${hits}); use at most ${MAX_EVENTS} per instrument`, path: [name] });
    }
  });
};

const noteSchema = (steps: number) => z.object({ step: stepIn(steps), note: pitch, dur, velocity });

export const bassBarSchema = (steps: number) =>
  z
    .array(noteSchema(steps))
    .min(1, 'each bar needs at least one note')
    .max(MAX_EVENTS, `at most ${MAX_EVENTS} notes per bar`)
    .superRefine((notes, ctx) => {
      const i = firstOutOfOrder(notes);
      if (i >= 0) ctx.addIssue({ code: 'custom', message: ASCENDING, path: [i, 'step'] });
    });

const chordSchema = (steps: number) =>
  z
    .object({ step: stepIn(steps), notes: z.array(pitch).min(2).max(5), dur, velocity })
    .superRefine((chord, ctx) => {
      if (new Set(chord.notes).size !== chord.notes.length) {
        ctx.addIssue({ code: 'custom', message: 'chord notes must be distinct', path: ['notes'] });
      }
      if (chord.notes.some((n) => octave(n) < 2 || octave(n) > 5)) {
        ctx.addIssue({ code: 'custom', message: 'chord notes must be in octaves 2 to 5', path: ['notes'] });
      }
    });

export const keysBarSchema = (steps: number) =>
  z
    .array(chordSchema(steps))
    .min(1, 'each bar needs at least one chord')
    .max(6)
    .superRefine((chords, ctx) => {
      const i = firstOutOfOrder(chords);
      if (i >= 0) ctx.addIssue({ code: 'custom', message: ASCENDING, path: [i, 'step'] });
    });

export const melodyBarSchema = (steps: number) =>
  z
    .array(noteSchema(steps).refine((n) => octave(n.note) >= 4 && octave(n.note) <= 6, { message: 'melody notes must be in octaves 4 to 6', path: ['note'] }))
    .max(12)
    .superRefine((notes, ctx) => {
      const i = firstOutOfOrder(notes);
      if (i >= 0) ctx.addIssue({ code: 'custom', message: ASCENDING, path: [i, 'step'] });
    });

// ---------- Replies ----------

export const conductorReplySchema = z.object({
  bpm: z
    .number()
    .min(60)
    .max(180)
    .transform((n) => Math.round(n)),
  key: z
    .string()
    .trim()
    .regex(/^[A-G][#b]?\s(major|minor|dorian|phrygian|lydian|mixolydian|locrian)$/i, 'key must look like "A minor" or "F# dorian"'),
  timeSignature: timeSignatureSchema,
  // Lenient on purpose: a missing or odd preset is repaired from the vibe instead of costing a retry.
  preset: z.string().optional(),
  // Lenient on purpose, like the preset: the arrangement and a steer's section are repaired by sanitizeArrangement and sectionNameOf instead of costing a retry.
  sections: z.unknown().optional(),
  section: z.unknown().optional(),
  why,
});

export const drumsReplySchema = (steps: number) => z.object({ why, echoes, bars: z.array(drumBarSchema(steps)).length(BARS) });

/** Bass reply schema, aware of the drums it must lock to: a note has to land on each bar's first kick. */
export function bassReplySchema(steps: number, drums: { kick: number[] }[]) {
  return z.object({ why, echoes, bars: z.array(bassBarSchema(steps)).length(BARS) }).superRefine((reply, ctx) => {
    reply.bars.forEach((bar, b) => {
      const firstKick = drums[b]?.kick.indexOf(1) ?? -1;
      if (firstKick >= 0 && !bar.some((n) => n.step === firstKick)) {
        ctx.addIssue({
          code: 'custom',
          message: `bar ${b + 1}: the kick first hits on step ${firstKick}, so the bass needs a note on step ${firstKick}`,
          path: ['bars', b],
        });
      }
    });
  });
}

/** More than 4 bars from the keys player are cut down to the first 4 (before validating, so a bad extra bar cannot fail the reply). */
const firstFourBars = (value: unknown) => (Array.isArray(value) && value.length > BARS ? value.slice(0, BARS) : value);

export const keysReplySchema = (steps: number) => z.object({ why, echoes, bars: z.preprocess(firstFourBars, z.array(keysBarSchema(steps)).length(BARS)) });

export const melodyReplySchema = (steps: number) =>
  z.object({ why, echoes, bars: z.array(melodyBarSchema(steps)).length(BARS) }).superRefine((reply, ctx) => {
    const total = reply.bars.reduce((sum, bar) => sum + bar.length, 0);
    if (total < 3) ctx.addIssue({ code: 'custom', message: 'the melody needs at least 3 notes across the 4 bars', path: ['bars'] });
  });

// ---------- Requests ----------

/** What a musician is told about the block it writes: the song section and the chord of each of the 4 bars. */
export const blockPlanSchema = z.object({
  section: z.enum(SECTION_NAMES),
  sectionBar: z.number().int().min(1).max(64),
  sectionBars: z.number().int().min(4).max(64),
  chords: z.array(z.string().trim().max(12)).length(BARS),
});

export const conductorRequestSchema = z.object({
  vibe: z.string().trim().min(1).max(300),
  /** Browser-made id of this run; keys the band's memory in Neo4j */
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  /** Live steering while the band plays: the listener's text plus the settings the band is using right now */
  steer: z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_:-]{3,100}$/).optional(),
      text: z.string().trim().min(1).max(200),
      atBlock: z.number().int().min(0).max(100000).optional(),
      current: z.object({
        bpm: z.number().min(40).max(220),
        key: z.string().min(1).max(40),
        timeSignature: timeSignatureSchema,
        preset: z.string().max(20),
      }),
    })
    .optional(),
  overrides: z
    .object({
      bpm: z.number().int().min(60).max(180).optional(),
      timeSignature: timeSignatureSchema.optional(),
    })
    .default({}),
});

// The shared state is validated loosely (it is our own earlier output); the new parts that arrive with a request are validated strictly against the meter.
const looseRow = z.array(bit).min(1).max(32);
const looseNote = z.object({ step: z.number().int().min(0).max(31), note: z.string().max(4), dur: z.string().max(4), velocity: z.number().min(0).max(1).optional() });
const looseChord = z.object({ step: z.number().int().min(0).max(31), notes: z.array(z.string().max(4)).max(6), dur: z.string().max(4), velocity: z.number().min(0).max(1).optional() });

export const jamStateSchema = z.object({
  tempo: z.number().min(40).max(220),
  key: z.string().min(1).max(40),
  timeSignature: timeSignatureSchema,
  vibe: z.string().trim().min(1).max(300),
  steer: z.object({ text: z.string().max(200), direction: z.string().max(300) }).optional(),
  bars: z
    .array(
      z.object({
        key: z.string().max(40).optional(),
        timeSignature: timeSignatureSchema.optional(),
        drums: z.object({
          kick: looseRow,
          snare: looseRow,
          hat: looseRow,
          velocity: z.object({ kick: z.array(z.number()).max(32).optional(), snare: z.array(z.number()).max(32).optional(), hat: z.array(z.number()).max(32).optional() }).optional(),
        }),
        bass: z.array(looseNote).nullable(),
        keys: z.array(looseChord).nullable(),
        melody: z.array(looseNote).nullable(),
      }),
    )
    .max(64),
});
