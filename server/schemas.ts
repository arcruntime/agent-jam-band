import { z } from 'zod';

export const STEPS = 16;
export const BARS = 4;
export const DURATIONS = ['16n', '8n', '8n.', '4n', '4n.', '2n', '1n'] as const;

const bit = z.number().int().min(0).max(1);
const row = z.array(bit).length(STEPS);
const why = z.string().trim().min(1).max(200);

export const drumBarSchema = z.object({ kick: row, snare: row, hat: row });

export const bassNoteSchema = z.object({
  step: z.number().int().min(0).max(STEPS - 1),
  note: z.string().regex(/^[A-G][#b]?[0-8]$/, 'note must look like "A2" or "C#3"'),
  dur: z.enum(DURATIONS),
});

export const bassBarSchema = z
  .array(bassNoteSchema)
  .min(1, 'each bar needs at least one note')
  .superRefine((notes, ctx) => {
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].step <= notes[i - 1].step) {
        ctx.addIssue({ code: 'custom', message: 'steps must be strictly ascending (one note per step)', path: [i, 'step'] });
        return;
      }
    }
  });

export const drumsReplySchema = z.object({
  why,
  bars: z.array(drumBarSchema).length(BARS),
});

/** Bass reply schema, aware of the drums it must lock to: a note has to land on each bar's first kick. */
export function bassReplySchema(drums: z.infer<typeof drumBarSchema>[]) {
  return z
    .object({ why, bars: z.array(bassBarSchema).length(BARS) })
    .superRefine((reply, ctx) => {
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

export const jamStateSchema = z.object({
  tempo: z.number().min(40).max(220),
  key: z.string().min(1).max(40),
  vibe: z.string().trim().min(1).max(300),
  bars: z.array(z.object({ drums: drumBarSchema, bass: bassBarSchema.nullable() })).max(64),
});

export const drumsRequestSchema = z.object({ state: jamStateSchema });
export const bassRequestSchema = z.object({
  state: jamStateSchema,
  drums: z.array(drumBarSchema).length(BARS),
});
