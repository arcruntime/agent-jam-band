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
import type { VoxStyle } from '../shared/vox';

/** Formant centre frequencies in Hz with the level of each band, a little adapted from the classic adult vowel tables (ah /a/, oh /o/, ee /i/, oo /u/). */
export const FORMANTS: Record<Vowel, readonly (readonly [hz: number, gain: number])[]> = {
  ah: [[800, 1], [1200, 0.55], [2800, 0.3]],
  oh: [[450, 1], [800, 0.5], [2830, 0.2]],
  ee: [[270, 1], [2300, 0.6], [3000, 0.35]],
  oo: [[300, 1], [870, 0.4], [2240, 0.15]],
};

/** Peakiness of each formant band: higher = a more obvious vowel, lower = a breathier one. */
const FORMANT_Q = [4.5, 6, 8];
/** How fast the bands move to a new vowel (time constant in seconds): quick enough to be a new syllable, slow enough not to click. */
const VOWEL_MORPH_S = 0.012;
/** Output level the voice is built to: the filtered buzz is scaled so a full-strength chop peaks around this before the crusher. Set by measuring, see the vox tests. */
const MAKEUP = 3.2;
/** Gain after the crusher. Three narrow bandpass filters keep only about a third of the source's level, and the source itself (one FM oscillator) is a lot quieter than a Tone.Synth, so without this the chops sat about 10 dB under the melody even with the bus 3 dB below it. It is after the crusher so the quantizer input stays under full scale. */
const BOOST = 2.1;

/** How one style sounds. The bit depth is per preset (see audio.ts), because the electronic presets glitch more than the warm ones. */
export interface VoxTimbre {
  /** Cut below this (Hz): 400 keeps the stabs out of the melody's and the keys' low end. */
  highpass: number;
  /** Warmth: everything above this is rolled off (Hz). The builds sweep it open, see setOpen. */
  lowpass: number;
  /** A broad dip at 3.2 kHz in dB (0 = none) that leaves the lead its presence band (2-5 kHz). */
  presenceCutDb: number;
  /** FM depth of the source: more is brighter and buzzier. */
  brightness: number;
  /** How many semitones below the note a chop starts, and how long the glide up takes. */
  glideSemitones: number;
  glideSeconds: number;
  env: { attack: number; decay: number; sustain: number; release: number };
  /** The longest a chop may ring (seconds); an agent's longer duration is cut to this. */
  maxChop: number;
}

export const TIMBRES: Record<VoxStyle, VoxTimbre> = {
  // Short, bright, glitchy: a fast attack, a quick fall to a low sustain, and no low end.
  stab: { highpass: 400, lowpass: 10000, presenceCutDb: 0, brightness: 2.4, glideSemitones: 3, glideSeconds: 0.03, env: { attack: 0.003, decay: 0.05, sustain: 0.3, release: 0.05 }, maxChop: 0.18 },
  // Sustained, warm, a little dull on top, with the lead's presence band cut back.
  vocoder: { highpass: 90, lowpass: 3600, presenceCutDb: -5, brightness: 1, glideSemitones: 1, glideSeconds: 0.06, env: { attack: 0.02, decay: 0.12, sustain: 0.85, release: 0.25 }, maxChop: 1.2 },
  // Slow, soft and airy.
  pad: { highpass: 150, lowpass: 5200, presenceCutDb: -3, brightness: 0.5, glideSemitones: 0.4, glideSeconds: 0.12, env: { attack: 0.08, decay: 0.15, sustain: 0.9, release: 0.5 }, maxChop: 2 },
  rare: { highpass: 150, lowpass: 5200, presenceCutDb: -3, brightness: 0.5, glideSemitones: 0.4, glideSeconds: 0.12, env: { attack: 0.08, decay: 0.15, sustain: 0.9, release: 0.5 }, maxChop: 1.2 },
};

export interface VoxVoiceOptions {
  /** Bit depth of the crusher: 4 is very robotic, 8 is gentle, 16 or more bypasses it. */
  bits?: number;
  style?: VoxStyle;
}

export interface VoxVoice {
  /** Connect this node to whatever should hear the voice. */
  readonly output: Tone.Gain;
  /** Sing one chop at audio time `time` for `dur` seconds, at strength 0-1. */
  sing(note: string, vowel: Vowel, dur: number, time: number, velocity: number): void;
  /** Change the crusher's bit depth (16 or more bypasses it). Takes effect on the next chop. */
  setBits(bits: number): void;
  /** Switch the voice to a style's timbre (filters, glide, envelope), and its crusher depth. */
  setStyle(style: VoxStyle, bits: number): void;
  /** How far the filter is open, 0-1 (1 = the style's own cutoff). Ramps over `rampSeconds` from audio time `time`: builds use it to sweep the vox open. */
  setOpen(open: number, time: number, rampSeconds: number): void;
  /** The style's longest chop in seconds. */
  readonly maxChop: number;
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
  let timbre: VoxTimbre = TIMBRES[options.style ?? 'stab'];

  const output = new Tone.Gain(1);
  // Evens out the vowels: a sharp resonance can land on a harmonic (a loud "ah" at some pitches) while another vowel on another note is 9 dB down.
  const leveler = new Tone.Compressor({ threshold: -26, ratio: 4, attack: 0.003, release: 0.08 }).connect(output);
  const boost = new Tone.Gain(BOOST).connect(leveler);
  const lowpass = new Tone.Filter(timbre.lowpass, 'lowpass').connect(boost); // warmth, and it tames the fizz the crusher adds
  const presence = new Tone.Filter({ type: 'peaking', frequency: 3200, Q: 0.7, gain: timbre.presenceCutDb }).connect(lowpass);
  const highpass = new Tone.Filter(timbre.highpass, 'highpass').connect(presence);
  const crusher = new Tone.WaveShaper(quantizer(options.bits ?? 6), 4096).connect(highpass);
  const makeup = new Tone.Gain(MAKEUP).connect(crusher);

  const env = new Tone.AmplitudeEnvelope({ ...timbre.env });
  const bands = FORMANTS.ah.map(([hz, gain], i) => {
    const filter = new Tone.Filter({ type: 'bandpass', frequency: hz, Q: FORMANT_Q[i] });
    const level = new Tone.Gain(gain);
    env.connect(filter);
    filter.connect(level);
    level.connect(makeup);
    return { filter, level };
  });

  const osc = new Tone.FMOscillator({ frequency: 220, type: 'sawtooth', modulationType: 'sine', harmonicity: 1, modulationIndex: timbre.brightness }).connect(env);
  osc.start();

  return {
    output,

    sing(note, vowel, dur, time, velocity) {
      const hz = Tone.Frequency(note).toFrequency();
      osc.frequency.cancelScheduledValues(time);
      osc.frequency.setValueAtTime(hz * 2 ** (-timbre.glideSemitones / 12), time);
      osc.frequency.exponentialRampToValueAtTime(hz, time + timbre.glideSeconds);

      const target = FORMANTS[vowel];
      bands.forEach(({ filter, level }, i) => {
        filter.frequency.cancelScheduledValues(time);
        filter.frequency.setTargetAtTime(target[i][0], time, VOWEL_MORPH_S);
        level.gain.cancelScheduledValues(time);
        level.gain.setTargetAtTime(target[i][1], time, VOWEL_MORPH_S);
      });

      env.triggerAttackRelease(Math.min(timbre.maxChop, Math.max(0.03, dur)), time, Math.max(0, Math.min(1, velocity)));
    },

    setBits(bits) {
      crusher.setMap(quantizer(bits));
    },

    setStyle(style, bits) {
      timbre = TIMBRES[style];
      crusher.setMap(quantizer(bits));
      highpass.frequency.value = timbre.highpass;
      presence.gain.value = timbre.presenceCutDb;
      lowpass.frequency.value = timbre.lowpass;
      env.attack = timbre.env.attack;
      env.decay = timbre.env.decay;
      env.sustain = timbre.env.sustain;
      env.release = timbre.env.release;
      osc.modulationIndex.value = timbre.brightness;
    },

    setOpen(open, time, rampSeconds) {
      const o = Math.min(1, Math.max(0, open));
      // From an eighth of the style's cutoff up to all of it, on a log scale, so it sounds like an even sweep.
      const hz = timbre.lowpass * 0.12 ** (1 - o);
      lowpass.frequency.cancelScheduledValues(time);
      lowpass.frequency.setValueAtTime(lowpass.frequency.value, time);
      lowpass.frequency.exponentialRampToValueAtTime(Math.max(200, hz), time + Math.max(0.01, rampSeconds));
    },

    get maxChop() {
      return timbre.maxChop;
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
      presence.dispose();
      highpass.dispose();
      boost.dispose();
      leveler.dispose();
      output.dispose();
    },
  };
}
