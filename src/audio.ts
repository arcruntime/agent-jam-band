/**
 * The band's sound, built only from Tone.js synths and effects (no samples).
 *
 *   drums:  kick (MembraneSynth) | snare (NoiseSynth + short triangle tone) | hats (MetalSynth)
 *   bass:   MonoSynth -> Distortion
 *   keys:   PolySynth of fat saws -> lowpass -> reverb -> "sidechain" duck gain
 *   melody: Synth (square/saw) -> lowpass -> vibrato -> ping-pong delay
 *   all:    -> master lowpass -> limiter -> speakers
 *
 * The conductor's `preset` decides the synth settings and effect amounts (see PRESETS).
 * The levels below are starting points chosen without listening tests; nudge `volume` values to taste.
 */
import * as Tone from 'tone';
import type { SoundPreset } from '../shared/presets';
import type { StepEvents } from './steps';

type Wave = 'sawtooth' | 'square';

interface PresetSettings {
  /** Master lowpass in Hz: lower = duller, warmer */
  masterLowpass: number;
  kick: { octaves: number; decay: number; volume: number };
  snare: { noiseDecay: number; noiseHighpass: number; noiseVolume: number; toneHz: number; toneVolume: number };
  hat: { decay: number; volume: number; hz: number; resonance: number };
  bass: { wave: Wave; baseFrequency: number; filterOctaves: number; q: number; distortion: number; release: number; volume: number };
  keys: { spread: number; attack: number; release: number; lowpass: number; reverbWet: number; reverbDecay: number; duckDb: number; volume: number };
  melody: { wave: Wave; attack: number; release: number; lowpass: number; vibratoHz: number; vibratoDepth: number; delayWet: number; delayFeedback: number; volume: number };
}

export const PRESETS: Record<SoundPreset, PresetSettings> = {
  // Dusty and warm: dull top end, soft hats, gentle ducking, roomy keys.
  lofi: {
    masterLowpass: 6500,
    kick: { octaves: 6, decay: 0.28, volume: -5 },
    snare: { noiseDecay: 0.14, noiseHighpass: 1200, noiseVolume: -16, toneHz: 190, toneVolume: -18 },
    hat: { decay: 0.035, volume: -32, hz: 220, resonance: 3500 },
    bass: { wave: 'sawtooth', baseFrequency: 90, filterOctaves: 2.2, q: 2, distortion: 0.1, release: 0.2, volume: -7 },
    keys: { spread: 24, attack: 0.04, release: 1.2, lowpass: 1800, reverbWet: 0.35, reverbDecay: 2.6, duckDb: -6, volume: -24 },
    melody: { wave: 'square', attack: 0.03, release: 0.5, lowpass: 2200, vibratoHz: 4.5, vibratoDepth: 0.12, delayWet: 0.25, delayFeedback: 0.3, volume: -20 },
  },
  // Wide, bright and pumping.
  futurebass: {
    masterLowpass: 20000,
    kick: { octaves: 6, decay: 0.35, volume: -3 },
    snare: { noiseDecay: 0.2, noiseHighpass: 1500, noiseVolume: -12, toneHz: 200, toneVolume: -14 },
    hat: { decay: 0.04, volume: -28, hz: 300, resonance: 4500 },
    bass: { wave: 'sawtooth', baseFrequency: 140, filterOctaves: 3.5, q: 3, distortion: 0.25, release: 0.25, volume: -7 },
    keys: { spread: 45, attack: 0.01, release: 0.6, lowpass: 3500, reverbWet: 0.3, reverbDecay: 2.2, duckDb: -8, volume: -22 },
    melody: { wave: 'sawtooth', attack: 0.02, release: 0.4, lowpass: 6000, vibratoHz: 5.5, vibratoDepth: 0.15, delayWet: 0.25, delayFeedback: 0.35, volume: -17 },
  },
  // Tight and driving: strong kick, plucky bass, hard pumping keys.
  house: {
    masterLowpass: 20000,
    kick: { octaves: 6, decay: 0.3, volume: -2 },
    snare: { noiseDecay: 0.18, noiseHighpass: 1800, noiseVolume: -13, toneHz: 220, toneVolume: -16 },
    hat: { decay: 0.05, volume: -28, hz: 320, resonance: 5000 },
    bass: { wave: 'sawtooth', baseFrequency: 110, filterOctaves: 3, q: 4, distortion: 0.15, release: 0.12, volume: -6 },
    keys: { spread: 30, attack: 0.01, release: 0.4, lowpass: 2500, reverbWet: 0.25, reverbDecay: 1.8, duckDb: -8, volume: -22 },
    melody: { wave: 'square', attack: 0.01, release: 0.3, lowpass: 5000, vibratoHz: 5, vibratoDepth: 0.08, delayWet: 0.2, delayFeedback: 0.3, volume: -18 },
  },
  // Dry and gritty: more bass drive, little reverb, bigger snare.
  rock: {
    masterLowpass: 20000,
    kick: { octaves: 6, decay: 0.25, volume: -3 },
    snare: { noiseDecay: 0.22, noiseHighpass: 1000, noiseVolume: -11, toneHz: 170, toneVolume: -13 },
    hat: { decay: 0.06, volume: -28, hz: 260, resonance: 4000 },
    bass: { wave: 'sawtooth', baseFrequency: 150, filterOctaves: 2.5, q: 2, distortion: 0.4, release: 0.15, volume: -8 },
    keys: { spread: 20, attack: 0.01, release: 0.4, lowpass: 2200, reverbWet: 0.15, reverbDecay: 1.2, duckDb: -3, volume: -23 },
    melody: { wave: 'sawtooth', attack: 0.01, release: 0.3, lowpass: 4500, vibratoHz: 5.5, vibratoDepth: 0.2, delayWet: 0.15, delayFeedback: 0.25, volume: -19 },
  },
  // Slow and washed out: soft drums, long pads, lots of space.
  ambient: {
    masterLowpass: 9000,
    kick: { octaves: 4, decay: 0.4, volume: -9 },
    snare: { noiseDecay: 0.3, noiseHighpass: 900, noiseVolume: -20, toneHz: 160, toneVolume: -22 },
    hat: { decay: 0.08, volume: -34, hz: 200, resonance: 3000 },
    bass: { wave: 'sawtooth', baseFrequency: 70, filterOctaves: 1.8, q: 1, distortion: 0.05, release: 0.6, volume: -11 },
    keys: { spread: 50, attack: 0.6, release: 3, lowpass: 3000, reverbWet: 0.6, reverbDecay: 6, duckDb: -2, volume: -24 },
    melody: { wave: 'square', attack: 0.1, release: 1.5, lowpass: 1800, vibratoHz: 4, vibratoDepth: 0.2, delayWet: 0.35, delayFeedback: 0.45, volume: -22 },
  },
};

export interface Rig {
  /** Configure every synth and effect for a preset. Call after the transport bpm is set, because the delay time follows the tempo. */
  applyPreset(preset: SoundPreset): Promise<void>;
  /** Trigger everything that sounds on one step, at audio time `time`. */
  play(ev: StepEvents, time: number): void;
  /** Cut off anything still ringing (Stop). */
  silence(): void;
  /** The gain node that ducks the keys on every kick (exposed for tests). */
  readonly duckGain: Tone.Gain;
  readonly preset: SoundPreset | null;
}

/** Build the whole audio graph on the current Tone context. */
export function createRig(): Rig {
  // ---- master ----
  const limiter = new Tone.Limiter(-1).toDestination();
  const master = new Tone.Filter(20000, 'lowpass').connect(limiter);

  // ---- drums ----
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
  }).connect(master);

  const snareNoiseFilter = new Tone.Filter(1500, 'highpass').connect(master);
  const snareNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
  }).connect(snareNoiseFilter);
  const snareTone = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.02 },
  }).connect(master);

  const hat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
  }).connect(master);

  // ---- bass ----
  const bassDistortion = new Tone.Distortion(0.2).connect(master);
  const bass = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15 },
    filter: { Q: 2, type: 'lowpass', rolloff: -24 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 120, octaves: 3 },
  }).connect(bassDistortion);

  // ---- keys: fat saws -> lowpass -> reverb -> duck ----
  const duck = new Tone.Gain(1).connect(master);
  const keysReverb = new Tone.Reverb({ decay: 2.5, wet: 0.3 }).connect(duck);
  const keysFilter = new Tone.Filter(2500, 'lowpass').connect(keysReverb);
  const keys = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
    envelope: { attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.8 },
  }).connect(keysFilter);

  // ---- melody: lead -> lowpass -> vibrato -> ping-pong delay ----
  const delay = new Tone.PingPongDelay({ delayTime: '8n', feedback: 0.3, wet: 0.2 }).connect(master);
  const vibrato = new Tone.Vibrato(5, 0.1).connect(delay);
  const melodyFilter = new Tone.Filter(5000, 'lowpass').connect(vibrato);
  const melody = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.4 },
  }).connect(melodyFilter);

  let current: SoundPreset | null = null;
  let settings: PresetSettings = PRESETS.lofi;

  /** Dip the keys by the preset's duckDb at `time`, then recover over an eighth note. */
  function duckKeys(time: number) {
    if (settings.keys.duckDb >= 0) return;
    const recover = Tone.Time('8n').toSeconds();
    duck.gain.cancelScheduledValues(time);
    duck.gain.setValueAtTime(Tone.dbToGain(settings.keys.duckDb), time);
    duck.gain.linearRampToValueAtTime(1, time + recover);
  }

  /** A bad note from an agent must never take the transport down, so every trigger is guarded. */
  const safely = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.warn(`[audio] ${what} skipped:`, err);
    }
  };

  return {
    get duckGain() {
      return duck;
    },
    get preset() {
      return current;
    },

    async applyPreset(preset) {
      const p = PRESETS[preset];
      current = preset;
      settings = p;

      master.frequency.value = p.masterLowpass;

      kick.set({ pitchDecay: 0.05, octaves: p.kick.octaves, envelope: { decay: p.kick.decay } });
      kick.volume.value = p.kick.volume;

      snareNoise.set({ envelope: { decay: p.snare.noiseDecay } });
      snareNoiseFilter.frequency.value = p.snare.noiseHighpass;
      snareNoise.volume.value = p.snare.noiseVolume;
      snareTone.volume.value = p.snare.toneVolume;

      hat.set({ envelope: { decay: p.hat.decay }, resonance: p.hat.resonance });
      hat.volume.value = p.hat.volume;

      bass.set({
        oscillator: { type: p.bass.wave },
        envelope: { release: p.bass.release },
        filter: { Q: p.bass.q },
        filterEnvelope: { baseFrequency: p.bass.baseFrequency, octaves: p.bass.filterOctaves },
      });
      bassDistortion.distortion = p.bass.distortion;
      bass.volume.value = p.bass.volume;

      keys.set({
        oscillator: { type: 'fatsawtooth', count: 3, spread: p.keys.spread },
        envelope: { attack: p.keys.attack, release: p.keys.release },
      });
      keys.volume.value = p.keys.volume;
      keysFilter.frequency.value = p.keys.lowpass;
      keysReverb.wet.value = p.keys.reverbWet;
      keysReverb.decay = p.keys.reverbDecay; // regenerates the impulse response...
      await keysReverb.ready; // ...which takes a moment

      melody.set({
        oscillator: { type: p.melody.wave },
        envelope: { attack: p.melody.attack, release: p.melody.release },
      });
      melody.volume.value = p.melody.volume;
      melodyFilter.frequency.value = p.melody.lowpass;
      vibrato.frequency.value = p.melody.vibratoHz;
      vibrato.depth.value = p.melody.vibratoDepth;
      delay.delayTime.value = Tone.Time('8n').toSeconds(); // an eighth note at the current bpm
      delay.feedback.value = p.melody.delayFeedback;
      delay.wet.value = p.melody.delayWet;
    },

    play(ev, time) {
      if (ev.kick) {
        safely('kick', () => kick.triggerAttackRelease('C1', '8n', time));
        safely('duck', () => duckKeys(time));
      }
      if (ev.snare) {
        safely('snare', () => {
          snareNoise.triggerAttackRelease('16n', time);
          snareTone.triggerAttackRelease(settings.snare.toneHz, '32n', time);
        });
      }
      if (ev.hat) safely('hat', () => hat.triggerAttackRelease(settings.hat.hz, '32n', time));
      for (const n of ev.bass) safely('bass', () => bass.triggerAttackRelease(n.note, n.dur, time));
      for (const c of ev.keys) safely('keys', () => keys.triggerAttackRelease(c.notes, c.dur, time));
      for (const n of ev.melody) safely('melody', () => melody.triggerAttackRelease(n.note, n.dur, time));
    },

    silence() {
      safely('silence', () => {
        keys.releaseAll();
        bass.triggerRelease();
        melody.triggerRelease();
        duck.gain.cancelScheduledValues(0);
        duck.gain.value = 1;
      });
    },
  };
}

let rig: Rig | undefined;

/** The shared rig. Create it only after Tone.start() so the audio context exists. */
export function getRig(): Rig {
  rig ??= createRig();
  return rig;
}
