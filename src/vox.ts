/**
 * The robot voice: short vowel-like chops made from a synth, with no audio model and no samples.
 *
 *   FM sawtooth (a buzzy "glottal" source) -> amplitude envelope -> three parallel bandpass filters at the vowel's formants -> makeup gain -> bit quantizer -> lowpass
 *
 * A vowel is just where the spectrum has peaks (formants), so each hit sets the three bandpass centres (and their levels) for its vowel. The source pitch starts a few semitones low and glides up to the note in about 40 ms, which is what makes it sound like a chop rather than an organ.
 * The bit quantizer is a WaveShaper with a stepped curve: it crushes the amplitude to 2^bits levels for the robotic grit, it needs no AudioWorklet, and it can be loosened or bypassed.
 * The voice is monophonic: a new chop takes over the filters and the envelope from the previous one, which is how a single singer behaves.
 */
import * as Tone from 'tone';
import type { Vowel } from '../shared/types';

/** Formant centre frequencies in Hz with the level of each band, a little adapted from the classic adult vowel tables (ah /a/, oh /o/, ee /i/, oo /u/). */
export const FORMANTS: Record<Vowel, readonly (readonly [hz: number, gain: number])[]> = {
  ah: [[800, 1], [1200, 0.55], [2800, 0.3]],
  oh: [[450, 1], [800, 0.5], [2830, 0.2]],
  ee: [[270, 1], [2300, 0.6], [3000, 0.35]],
  oo: [[300, 1], [870, 0.4], [2240, 0.15]],
};

/** Peakiness of each formant band: higher = a more obvious vowel, lower = a breathier one. */
const FORMANT_Q = [7, 9, 11];
/** How fast the bands move to a new vowel (time constant in seconds): quick enough to be a new syllable, slow enough not to click. */
const VOWEL_MORPH_S = 0.012;
/** Chops are short. A longer duration from an agent is cut to this. */
export const MAX_CHOP_S = 0.4;
/** Output level the voice is built to: the filtered buzz is scaled so a full-strength chop peaks around this before the crusher. Set by measuring, see the vox tests. */
const MAKEUP = 3.2;

export interface VoxVoiceOptions {
  /** Bit depth of the crusher: 4 is very robotic, 8 is gentle, 16 or more bypasses it. */
  bits?: number;
  /** The pitch glide: how many semitones below the note a chop starts, and how long it takes to arrive. */
  glideSemitones?: number;
  glideSeconds?: number;
}

export interface VoxVoice {
  /** Connect this node to whatever should hear the voice. */
  readonly output: Tone.Gain;
  /** Sing one chop at audio time `time` for `dur` seconds, at strength 0-1. */
  sing(note: string, vowel: Vowel, dur: number, time: number, velocity: number): void;
  /** Change the crusher's bit depth (16 or more bypasses it). Takes effect on the next chop. */
  setBits(bits: number): void;
  /** Let go of whatever is sounding. */
  silence(): void;
  dispose(): void;
}

/** A stepped transfer curve: the input (-1..1) is rounded to 2^(bits-1) levels each side of zero. */
const quantizer = (bits: number) => {
  if (bits >= 16) return (x: number) => x;
  const levels = 2 ** (Math.max(2, bits) - 1);
  return (x: number) => Math.round(x * levels) / levels;
};

export function createVoxVoice(options: VoxVoiceOptions = {}): VoxVoice {
  const glideSemitones = options.glideSemitones ?? 3;
  const glideSeconds = options.glideSeconds ?? 0.04;

  const output = new Tone.Gain(1);
  const lowpass = new Tone.Filter(7500, 'lowpass').connect(output); // tames the fizz the crusher adds
  const crusher = new Tone.WaveShaper(quantizer(options.bits ?? 6), 4096).connect(lowpass);
  const makeup = new Tone.Gain(MAKEUP).connect(crusher);

  const env = new Tone.AmplitudeEnvelope({ attack: 0.006, decay: 0.1, sustain: 0.55, release: 0.07 });
  const bands = FORMANTS.ah.map(([hz, gain], i) => {
    const filter = new Tone.Filter({ type: 'bandpass', frequency: hz, Q: FORMANT_Q[i] });
    const level = new Tone.Gain(gain);
    env.connect(filter);
    filter.connect(level);
    level.connect(makeup);
    return { filter, level };
  });

  const osc = new Tone.FMOscillator({ frequency: 220, type: 'sawtooth', modulationType: 'sine', harmonicity: 1, modulationIndex: 1.4 }).connect(env);
  osc.start();

  return {
    output,

    sing(note, vowel, dur, time, velocity) {
      const hz = Tone.Frequency(note).toFrequency();
      osc.frequency.cancelScheduledValues(time);
      osc.frequency.setValueAtTime(hz * 2 ** (-glideSemitones / 12), time);
      osc.frequency.exponentialRampToValueAtTime(hz, time + glideSeconds);

      const target = FORMANTS[vowel];
      bands.forEach(({ filter, level }, i) => {
        filter.frequency.cancelScheduledValues(time);
        filter.frequency.setTargetAtTime(target[i][0], time, VOWEL_MORPH_S);
        level.gain.cancelScheduledValues(time);
        level.gain.setTargetAtTime(target[i][1], time, VOWEL_MORPH_S);
      });

      env.triggerAttackRelease(Math.min(MAX_CHOP_S, Math.max(0.03, dur)), time, Math.max(0, Math.min(1, velocity)));
    },

    setBits(bits) {
      crusher.setMap(quantizer(bits));
    },

    silence() {
      env.triggerRelease();
    },

    dispose() {
      osc.dispose();
      env.dispose();
      for (const { filter, level } of bands) {
        filter.dispose();
        level.dispose();
      }
      makeup.dispose();
      crusher.dispose();
      lowpass.dispose();
      output.dispose();
    },
  };
}
