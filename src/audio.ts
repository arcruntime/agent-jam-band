/**
 * The band's sound, built only from Tone.js synths and effects (no samples).
 *
 *   drums:  kick (MembraneSynth) | snare (NoiseSynth + short triangle tone) | hats (MetalSynth)
 *   bass:   MonoSynth -> Distortion
 *   keys:   PolySynth of fat saws -> lowpass -> "sidechain" duck gain -> pan -0.2
 *   melody: Synth (square/saw) -> lowpass -> vibrato -> feedback delay -> pan +0.2
 *   keys and melody (only) also feed one shared reverb send
 *   all:    -> master lowpass -> EQ3 -> compressor -> limiter -> speakers (drums and bass go in dry and centered)
 *
 * The conductor's `preset` decides the synth settings, effect amounts and swing (see PRESETS).
 * Every event plays at the strength the agent gave it, with a random +-8 ms of timing on everything except the kick.
 * The levels below are starting points chosen without listening tests; nudge `volume` values to taste.
 */
import * as Tone from 'tone';
import type { SoundPreset } from '../shared/presets';
import type { StepEvents } from './steps';

type Wave = 'sawtooth' | 'square';

/** Random timing slack, in seconds, on everything except the kick. */
const JITTER_S = 0.008;
const jitter = () => (Math.random() * 2 - 1) * JITTER_S;

interface PresetSettings {
  /** Master lowpass in Hz: lower = duller, warmer */
  masterLowpass: number;
  /** Tone.Transport swing (0-1), applied to sixteenths */
  swing: number;
  kick: { octaves: number; decay: number; volume: number };
  snare: { noiseDecay: number; noiseHighpass: number; noiseVolume: number; toneHz: number; toneVolume: number };
  hat: { decay: number; volume: number; hz: number; resonance: number };
  bass: { wave: Wave; baseFrequency: number; filterOctaves: number; q: number; distortion: number; release: number; volume: number };
  keys: { spread: number; attack: number; release: number; lowpass: number; reverbWet: number; reverbDecay: number; duckDb: number; volume: number };
  melody: { wave: Wave; attack: number; release: number; lowpass: number; vibratoHz: number; vibratoDepth: number; delayWet: number; delayFeedback: number; reverbSend: number; volume: number };
}

export const PRESETS: Record<SoundPreset, PresetSettings> = {
  // Dusty and warm: dull top end, soft hats, gentle ducking, roomy keys.
  lofi: {
    masterLowpass: 6500,
    swing: 0.2,
    kick: { octaves: 6, decay: 0.28, volume: -5 },
    snare: { noiseDecay: 0.14, noiseHighpass: 1200, noiseVolume: -16, toneHz: 190, toneVolume: -18 },
    hat: { decay: 0.035, volume: -32, hz: 220, resonance: 3500 },
    bass: { wave: 'sawtooth', baseFrequency: 90, filterOctaves: 2.2, q: 2, distortion: 0.1, release: 0.2, volume: -7 },
    keys: { spread: 24, attack: 0.04, release: 1.2, lowpass: 1800, reverbWet: 0.35, reverbDecay: 2.6, duckDb: -6, volume: -24 },
    melody: { wave: 'square', attack: 0.03, release: 0.5, lowpass: 2200, vibratoHz: 4.5, vibratoDepth: 0.12, delayWet: 0.25, delayFeedback: 0.3, reverbSend: 0.25, volume: -20 },
  },
  // Wide, bright and pumping.
  futurebass: {
    masterLowpass: 20000,
    swing: 0.05,
    kick: { octaves: 6, decay: 0.35, volume: -3 },
    snare: { noiseDecay: 0.2, noiseHighpass: 1500, noiseVolume: -12, toneHz: 200, toneVolume: -14 },
    hat: { decay: 0.04, volume: -28, hz: 300, resonance: 4500 },
    bass: { wave: 'sawtooth', baseFrequency: 140, filterOctaves: 3.5, q: 3, distortion: 0.25, release: 0.25, volume: -7 },
    keys: { spread: 45, attack: 0.01, release: 0.6, lowpass: 3500, reverbWet: 0.3, reverbDecay: 2.2, duckDb: -8, volume: -22 },
    melody: { wave: 'sawtooth', attack: 0.02, release: 0.4, lowpass: 6000, vibratoHz: 5.5, vibratoDepth: 0.15, delayWet: 0.25, delayFeedback: 0.35, reverbSend: 0.2, volume: -17 },
  },
  // Tight and driving: strong kick, plucky bass, hard pumping keys.
  house: {
    masterLowpass: 20000,
    swing: 0.1,
    kick: { octaves: 6, decay: 0.3, volume: -2 },
    snare: { noiseDecay: 0.18, noiseHighpass: 1800, noiseVolume: -13, toneHz: 220, toneVolume: -16 },
    hat: { decay: 0.05, volume: -28, hz: 320, resonance: 5000 },
    bass: { wave: 'sawtooth', baseFrequency: 110, filterOctaves: 3, q: 4, distortion: 0.15, release: 0.12, volume: -6 },
    keys: { spread: 30, attack: 0.01, release: 0.4, lowpass: 2500, reverbWet: 0.25, reverbDecay: 1.8, duckDb: -8, volume: -22 },
    melody: { wave: 'square', attack: 0.01, release: 0.3, lowpass: 5000, vibratoHz: 5, vibratoDepth: 0.08, delayWet: 0.2, delayFeedback: 0.3, reverbSend: 0.15, volume: -18 },
  },
  // Dry and gritty: more bass drive, little reverb, bigger snare.
  rock: {
    masterLowpass: 20000,
    swing: 0,
    kick: { octaves: 6, decay: 0.25, volume: -3 },
    snare: { noiseDecay: 0.22, noiseHighpass: 1000, noiseVolume: -11, toneHz: 170, toneVolume: -13 },
    hat: { decay: 0.06, volume: -28, hz: 260, resonance: 4000 },
    bass: { wave: 'sawtooth', baseFrequency: 150, filterOctaves: 2.5, q: 2, distortion: 0.4, release: 0.15, volume: -8 },
    keys: { spread: 20, attack: 0.01, release: 0.4, lowpass: 2200, reverbWet: 0.15, reverbDecay: 1.2, duckDb: -3, volume: -23 },
    melody: { wave: 'sawtooth', attack: 0.01, release: 0.3, lowpass: 4500, vibratoHz: 5.5, vibratoDepth: 0.2, delayWet: 0.15, delayFeedback: 0.25, reverbSend: 0.1, volume: -19 },
  },
  // Slow and washed out: soft drums, long pads, lots of space.
  ambient: {
    masterLowpass: 9000,
    swing: 0,
    kick: { octaves: 4, decay: 0.4, volume: -9 },
    snare: { noiseDecay: 0.3, noiseHighpass: 900, noiseVolume: -20, toneHz: 160, toneVolume: -22 },
    hat: { decay: 0.08, volume: -34, hz: 200, resonance: 3000 },
    bass: { wave: 'sawtooth', baseFrequency: 70, filterOctaves: 1.8, q: 1, distortion: 0.05, release: 0.6, volume: -11 },
    keys: { spread: 50, attack: 0.6, release: 3, lowpass: 3000, reverbWet: 0.6, reverbDecay: 6, duckDb: -2, volume: -24 },
    melody: { wave: 'square', attack: 0.1, release: 1.5, lowpass: 1800, vibratoHz: 4, vibratoDepth: 0.2, delayWet: 0.35, delayFeedback: 0.45, reverbSend: 0.4, volume: -22 },
  },
};

export interface Rig {
  /** Configure every synth and effect for a preset. The delay time follows the tempo: pass the bpm when the transport is about to change (live steering), otherwise the transport's current bpm is used. Everything is applied at once; only the reverb tail regenerates afterwards. */
  applyPreset(preset: SoundPreset, bpm?: number): Promise<void>;
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
  // ---- master bus: preset lowpass -> EQ3 (flat to start with) -> compressor -> limiter -> speakers ----
  const limiter = new Tone.Limiter(-1).toDestination();
  const compressor = new Tone.Compressor({ threshold: -18, ratio: 3 }).connect(limiter);
  const eq = new Tone.EQ3().connect(compressor);
  const master = new Tone.Filter(20000, 'lowpass').connect(eq);

  // ---- one reverb shared by keys and melody (drums and bass never touch it) ----
  const reverb = new Tone.Reverb({ decay: 2.5, wet: 1 }).connect(master);
  const keysSend = new Tone.Gain(0.3).connect(reverb);
  const melodySend = new Tone.Gain(0.2).connect(reverb);

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

  // ---- keys: fat saws -> lowpass -> duck -> pan -0.2 (and the duck output also feeds the reverb send) ----
  const keysPan = new Tone.Panner(-0.2).connect(master);
  const duck = new Tone.Gain(1);
  duck.connect(keysPan);
  duck.connect(keysSend);
  const keysFilter = new Tone.Filter(2500, 'lowpass').connect(duck);
  const keys = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
    envelope: { attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.8 },
  }).connect(keysFilter);

  // ---- melody: lead -> lowpass -> vibrato -> feedback delay -> pan +0.2 (and the delay output also feeds the reverb send) ----
  const melodyPan = new Tone.Panner(0.2).connect(master);
  const delay = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0.2 });
  delay.connect(melodyPan);
  delay.connect(melodySend);
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

    async applyPreset(preset, bpm) {
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
      // The shared reverb: keys send level and decay come from the preset (2.5 s is the starting decay), the melody gets its own send level.
      keysSend.gain.value = p.keys.reverbWet;
      melodySend.gain.value = p.melody.reverbSend;
      const transport = Tone.getTransport();
      transport.swing = p.swing;
      transport.swingSubdivision = '16n';

      melody.set({
        oscillator: { type: p.melody.wave },
        envelope: { attack: p.melody.attack, release: p.melody.release },
      });
      melody.volume.value = p.melody.volume;
      melodyFilter.frequency.value = p.melody.lowpass;
      vibrato.frequency.value = p.melody.vibratoHz;
      vibrato.depth.value = p.melody.vibratoDepth;
      delay.delayTime.value = bpm ? 30 / bpm : Tone.Time('8n').toSeconds(); // an eighth note
      delay.feedback.value = p.melody.delayFeedback;
      delay.wet.value = p.melody.delayWet;

      // Last, because it is the only slow part: the new decay regenerates the impulse response.
      if (reverb.decay !== p.keys.reverbDecay) {
        reverb.decay = p.keys.reverbDecay;
        await reverb.ready;
      }
    },

    play(ev, time) {
      // The kick stays exactly on the grid (and the duck with it); everything else floats by up to +-8 ms.
      if (ev.kick) {
        safely('kick', () => kick.triggerAttackRelease('C1', '8n', time, ev.kick));
        safely('duck', () => duckKeys(time));
      }
      if (ev.snare) {
        safely('snare', () => {
          const t = time + jitter();
          snareNoise.triggerAttackRelease('16n', t, ev.snare);
          snareTone.triggerAttackRelease(settings.snare.toneHz, '32n', t, ev.snare);
        });
      }
      if (ev.hat) safely('hat', () => hat.triggerAttackRelease(settings.hat.hz, '32n', time + jitter(), ev.hat));
      for (const n of ev.bass) safely('bass', () => bass.triggerAttackRelease(n.note, n.dur, time + jitter(), n.velocity));
      for (const c of ev.keys) safely('keys', () => keys.triggerAttackRelease(c.notes, c.dur, time + jitter(), c.velocity));
      for (const n of ev.melody) safely('melody', () => melody.triggerAttackRelease(n.note, n.dur, time + jitter(), n.velocity));
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
