import { z } from 'zod';
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
const dur = z.enum(DURATIONS);
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
  return z.object({ kick: row, snare: row, hat: row }).superRefine((bar, ctx) => {
    const hits = [...bar.kick, ...bar.snare, ...bar.hat].reduce((sum, v) => sum + v, 0);
    if (hits > MAX_EVENTS) {
      ctx.addIssue({ code: 'custom', message: `too many hits in one bar (${hits}); use at most ${MAX_EVENTS} across kick, snare and hat combined` });
    }
  });
};

const noteSchema = (steps: number) => z.object({ step: stepIn(steps), note: pitch, dur });

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
    .object({ step: stepIn(steps), notes: z.array(pitch).min(2).max(5), dur })
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
  why,
});

export const drumsReplySchema = (steps: number) => z.object({ why, bars: z.array(drumBarSchema(steps)).length(BARS) });

/** Bass reply schema, aware of the drums it must lock to: a note has to land on each bar's first kick. */
export function bassReplySchema(steps: number, drums: z.infer<ReturnType<typeof drumBarSchema>>[]) {
  return z.object({ why, bars: z.array(bassBarSchema(steps)).length(BARS) }).superRefine((reply, ctx) => {
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

export const keysReplySchema = (steps: number) => z.object({ why, bars: z.array(keysBarSchema(steps)).length(BARS) });

export const melodyReplySchema = (steps: number) =>
  z.object({ why, bars: z.array(melodyBarSchema(steps)).length(BARS) }).superRefine((reply, ctx) => {
    const total = reply.bars.reduce((sum, bar) => sum + bar.length, 0);
    if (total < 3) ctx.addIssue({ code: 'custom', message: 'the melody needs at least 3 notes across the 4 bars', path: ['bars'] });
  });

// ---------- Requests ----------

export const conductorRequestSchema = z.object({
  vibe: z.string().trim().min(1).max(300),
  overrides: z
    .object({
      bpm: z.number().int().min(60).max(180).optional(),
      timeSignature: timeSignatureSchema.optional(),
    })
    .default({}),
});

// The shared state is validated loosely (it is our own earlier output); the new parts that arrive with a request are validated strictly against the meter.
const looseRow = z.array(bit).min(1).max(32);
const looseNote = z.object({ step: z.number().int().min(0).max(31), note: z.string().max(4), dur: z.string().max(4) });
const looseChord = z.object({ step: z.number().int().min(0).max(31), notes: z.array(z.string().max(4)).max(6), dur: z.string().max(4) });

export const jamStateSchema = z.object({
  tempo: z.number().min(40).max(220),
  key: z.string().min(1).max(40),
  timeSignature: timeSignatureSchema,
  vibe: z.string().trim().min(1).max(300),
  bars: z
    .array(
      z.object({
        key: z.string().max(40).optional(),
        drums: z.object({ kick: looseRow, snare: looseRow, hat: looseRow }),
        bass: z.array(looseNote).nullable(),
        keys: z.array(looseChord).nullable(),
        melody: z.array(looseNote).nullable(),
      }),
    )
    .max(64),
});
