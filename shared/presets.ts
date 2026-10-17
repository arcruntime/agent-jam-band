/** Sound presets the conductor can pick. The frontend maps each one to synth settings and effects. */
export const SOUND_PRESETS = ['lofi', 'futurebass', 'house', 'rock', 'ambient', 'dnb', 'jazz', 'hiphop'] as const;
export type SoundPreset = (typeof SOUND_PRESETS)[number];

export function isSoundPreset(value: unknown): value is SoundPreset {
  return typeof value === 'string' && (SOUND_PRESETS as readonly string[]).includes(value);
}
