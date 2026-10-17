/**
 * The band's sound: Tone.js synths and effects, plus real sampled instruments from `smplr` where a preset calls for them (see SAMPLE_PLAN).
 *
 *   drums:  sampled drum machine (808 or the rock machine) when loaded, otherwise kick (MembraneSynth) | snare (NoiseSynth + short triangle tone) | hats (MetalSynth)
 *   bass:   MonoSynth -> Distortion
 *   keys:   sampled electric or grand piano -> gentle 7 kHz lowpass -> duck gain, or the PolySynth of fat saws -> lowpass -> duck gain; then pan -0.2
 *   melody: Synth (square/saw) -> lowpass -> vibrato -> feedback delay -> pan +0.2
 *   keys and melody (only) also feed one shared reverb send
 *   all:    -> master lowpass -> EQ3 -> compressor -> limiter -> speakers (drums and bass go in dry and centered)
 *
 * The conductor's `preset` decides the synth settings, effect amounts and swing (see PRESETS).
 * Every event plays at the strength the agent gave it, with a random +-8 ms of timing on everything except the kick.
 * The levels below are starting points chosen without listening tests; nudge `volume` values to taste.
 *
 * Samples load once, on page load (`rig.load()`). If one fails or times out the preset keeps playing on its synth, and the reason goes to the console only.
 */
import { DrumMachine, ElectricPiano, SplendidGrandPiano, getDrumMachineNames } from 'smplr';
import * as Tone from 'tone';
import type { SoundPreset } from '../shared/presets';
import type { StepEvents } from './steps';

type Wave = 'sawtooth' | 'square' | 'triangle' | 'sine' | 'fatsawtooth';

/** Random timing slack, in seconds, on everything except the kick. */
const JITTER_S = 0.008;
const jitter = () => (Math.random() * 2 - 1) * JITTER_S;


// ---------- Sampled instruments (smplr) ----------

/** What a sampled instrument needs from smplr, whatever its version's exact typings say. */
interface Sampler {
  ready: Promise<void>;
  start(event: { note: string | number; velocity?: number; time?: number; duration?: number }): unknown;
  stop(): void;
  getGroupNames?(): string[];
}

type DrumKit = '808' | 'rock';
type KeysKit = 'ep' | 'piano';

/** Which sampled kit each preset uses (null = keep the synth). Futurebass keys stay on the supersaw. Bass and melody stay synths. */
const SAMPLE_PLAN: Record<SoundPreset, { drums: DrumKit | null; keys: KeysKit | null }> = {
  lofi: { drums: '808', keys: 'ep' },
  futurebass: { drums: '808', keys: null },
  house: { drums: '808', keys: null },
  rock: { drums: 'rock', keys: null },
  ambient: { drums: null, keys: 'piano' },
  dnb: { drums: null, keys: null }, // breakbeats and a reese bass are synth territory
  jazz: { drums: null, keys: 'piano' }, // the ride is the synth hat with a long decay
  hiphop: { drums: '808', keys: 'ep' },
};

/** Give up waiting for a kit after this long: the preset stays on its synth (a kit that arrives later is still picked up). */
const LOAD_TIMEOUT_MS = 30000;
/** Where gentle lowpass sits on sampled keys. */
const KEYS_SAMPLE_LOWPASS_HZ = 7000;
/** Sampled drum bus level, and per-drum velocity trims. Estimates chosen without listening: nudge to taste. */
const DRUM_BUS_DB = -3;
const DRUM_TRIM = { kick: 1, snare: 0.9, hat: 0.55 };

interface DrumSlot {
  inst: Sampler;
  kick: string;
  snare: string;
  hat: string;
}
type SlotState = 'loading' | 'ready' | 'failed';

/** smplr instruments are factories (older versions: classes). Try a plain call first, because calling a class without `new` throws before it does anything. */
function make<T>(factory: unknown, ctx: unknown, options: object): T {
  const f = factory as ((c: unknown, o: object) => T) & { new (c: unknown, o: object): T };
  try {
    return f(ctx, options);
  } catch (err) {
    if (err instanceof TypeError) return new f(ctx, options);
    throw err;
  }
}

const vel127 = (v: number) => Math.max(1, Math.min(127, Math.round(v * 127)));

interface PresetSettings {
  /** Master lowpass in Hz: lower = duller, warmer */
  masterLowpass: number;
  /** Tone.Transport swing (0-1) and the note length it applies to (sixteenths unless stated: jazz swings the eighths) */
  swing: number;
  swingSub?: '16n' | '8n';
  kick: { octaves: number; decay: number; volume: number };
  snare: { noiseDecay: number; noiseHighpass: number; noiseVolume: number; toneHz: number; toneVolume: number };
  hat: { decay: number; volume: number; hz: number; resonance: number };
  bass: { wave: Wave; spread?: number; baseFrequency: number; filterOctaves: number; q: number; distortion: number; release: number; volume: number };
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
  // Fast and tight: snappy kick and snare, bright hats, a detuned "reese" bass (two saws pulling against each other) with a growling filter.
  dnb: {
    masterLowpass: 16000,
    swing: 0,
    kick: { octaves: 5, decay: 0.2, volume: -3 },
    snare: { noiseDecay: 0.12, noiseHighpass: 2000, noiseVolume: -11, toneHz: 230, toneVolume: -15 },
    hat: { decay: 0.03, volume: -29, hz: 420, resonance: 5200 },
    bass: { wave: 'fatsawtooth', spread: 38, baseFrequency: 70, filterOctaves: 3.2, q: 4, distortion: 0.35, release: 0.15, volume: -8 },
    keys: { spread: 35, attack: 0.02, release: 0.5, lowpass: 3000, reverbWet: 0.3, reverbDecay: 2, duckDb: -9, volume: -23 },
    melody: { wave: 'sawtooth', attack: 0.01, release: 0.3, lowpass: 6000, vibratoHz: 5.5, vibratoDepth: 0.1, delayWet: 0.25, delayFeedback: 0.35, reverbSend: 0.2, volume: -18 },
  },
  // Smoky and loose: triplet-swung eighths, a soft kick, a ride (the hat voice left to ring), a round walking bass, a piano.
  jazz: {
    masterLowpass: 9000,
    swing: 0.5,
    swingSub: '8n',
    kick: { octaves: 4, decay: 0.22, volume: -12 },
    snare: { noiseDecay: 0.1, noiseHighpass: 1800, noiseVolume: -22, toneHz: 200, toneVolume: -24 },
    hat: { decay: 0.32, volume: -27, hz: 380, resonance: 2500 },
    bass: { wave: 'triangle', baseFrequency: 100, filterOctaves: 1.5, q: 1, distortion: 0, release: 0.25, volume: -6 },
    keys: { spread: 12, attack: 0.02, release: 1, lowpass: 2600, reverbWet: 0.3, reverbDecay: 2, duckDb: 0, volume: -23 },
    melody: { wave: 'triangle', attack: 0.02, release: 0.4, lowpass: 3000, vibratoHz: 5, vibratoDepth: 0.1, delayWet: 0.15, delayFeedback: 0.25, reverbSend: 0.25, volume: -19 },
  },
  // Boom bap: heavy kick and snare, a round sub, dusty top end and a very late off-beat (heavy swing).
  hiphop: {
    masterLowpass: 7500,
    swing: 0.42,
    kick: { octaves: 6, decay: 0.4, volume: -3 },
    snare: { noiseDecay: 0.16, noiseHighpass: 1000, noiseVolume: -13, toneHz: 180, toneVolume: -15 },
    hat: { decay: 0.04, volume: -30, hz: 250, resonance: 3500 },
    bass: { wave: 'sine', baseFrequency: 60, filterOctaves: 1, q: 1, distortion: 0.15, release: 0.3, volume: -4 },
    keys: { spread: 15, attack: 0.02, release: 0.9, lowpass: 2200, reverbWet: 0.22, reverbDecay: 1.6, duckDb: -4, volume: -23 },
    melody: { wave: 'square', attack: 0.02, release: 0.4, lowpass: 2800, vibratoHz: 4.5, vibratoDepth: 0.1, delayWet: 0.2, delayFeedback: 0.3, reverbSend: 0.2, volume: -20 },
  },
};

/** Live on/off switches for the Studio panel: each one bypasses a production tool so the listener can hear what it does. All on by default. */
export interface StudioState {
  /** EQ, compressor and limiter on the master bus */
  master: boolean;
  /** Swing, +-8 ms timing wobble and velocity variation */
  humanize: boolean;
  /** Keys dipping under the kick */
  ducking: boolean;
  /** Reverb send on keys and melody, and the melody's echo */
  sends: boolean;
  /** Keys left and melody right (off: both centered) */
  stereo: boolean;
}
export type StudioKey = keyof StudioState;
/** A fixed velocity for every hit when Humanize is off: no accents, no ghost notes, no agent dynamics. */
const FLAT_VELOCITY = 0.8;
/** Short ramp for every Studio switch, so toggling never clicks. */
const STUDIO_RAMP_S = 0.04;

export interface Rig {
  /** Configure every synth and effect for a preset. The delay time follows the tempo: pass the bpm when the transport is about to change (live steering), otherwise the transport's current bpm is used. Everything is applied at once; only the reverb tail regenerates afterwards. */
  applyPreset(preset: SoundPreset, bpm?: number): Promise<void>;
  /** Studio switches (see StudioState). Changes ramp over ~40 ms and never restart or retrigger anything. */
  getStudio(): StudioState;
  setStudio(key: StudioKey, on: boolean): void;
  /** Loads every sampled instrument (once). Resolves when all have loaded, failed or timed out; it never rejects, and failures only reach the console. */
  load(): Promise<void>;
  /** How each sampled instrument is doing (exposed for tests and debugging). */
  sampleStates(): Record<'drums808' | 'drumsRock' | 'ep' | 'piano', SlotState>;
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
  // The Studio "master bus" switch crossfades between the processed path and a straight wire, so it never clicks.
  const out = new Tone.Gain(1).toDestination();
  const limiter = new Tone.Limiter(-1).connect(out);
  const compressor = new Tone.Compressor({ threshold: -18, ratio: 3 }).connect(limiter);
  const eq = new Tone.EQ3().connect(compressor);
  const processed = new Tone.Gain(1).connect(eq);
  const bypass = new Tone.Gain(0).connect(out);
  const master = new Tone.Filter(20000, 'lowpass');
  master.connect(processed);
  master.connect(bypass);
  const studio: StudioState = { master: true, humanize: true, ducking: true, sends: true, stereo: true };

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

  // ---- sampled instruments: they join the same chains as the synths they replace ----
  // Drums go dry and centered into the master bus. Keys go through a gentle lowpass into the same duck gain (so ducking, pan and the shared reverb send all still apply).
  const sampleCtx = Tone.getContext().rawContext as unknown as BaseAudioContext;
  const asNode = (n: { input: unknown }) => n.input as AudioNode;
  const drumSampleBus = new Tone.Gain(Tone.dbToGain(DRUM_BUS_DB)).connect(master);
  const keysSampleLowpass = new Tone.Filter(KEYS_SAMPLE_LOWPASS_HZ, 'lowpass').connect(duck);
  const keysSampleGain = new Tone.Gain(Tone.dbToGain(PRESETS.lofi.keys.volume)).connect(keysSampleLowpass);

  const slots = {
    drums808: { state: 'loading' as SlotState, value: null as DrumSlot | null },
    drumsRock: { state: 'loading' as SlotState, value: null as DrumSlot | null },
    ep: { state: 'loading' as SlotState, value: null as Sampler | null },
    piano: { state: 'loading' as SlotState, value: null as Sampler | null },
  };

  /**
   * Runs one loader. On failure, or if it takes longer than LOAD_TIMEOUT_MS, the slot is marked failed (the synth plays instead) and the reason is logged once, to the console only.
   * A kit that finishes after the timeout is still adopted, from the next note on.
   */
  async function loadSlot(name: string, slot: { state: SlotState }, job: () => Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = job().then(() => {
      clearTimeout(timer);
      if (slot.state === 'failed') console.info(`[audio] sample "${name}" finished loading late, so it is used from now on`);
      slot.state = 'ready';
    });
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (slot.state === 'loading') {
          slot.state = 'failed';
          console.warn(`[audio] sample "${name}" is still loading after ${LOAD_TIMEOUT_MS / 1000} s, so the synth plays for now`);
        }
        resolve();
      }, LOAD_TIMEOUT_MS);
    });
    try {
      await Promise.race([run, late]);
    } catch (err) {
      clearTimeout(timer);
      slot.state = 'failed';
      console.warn(`[audio] sample "${name}" is not available, so the synth plays instead: ${(err as Error).message ?? err}`);
    }
  }

  async function loadDrums(name: string, slot: typeof slots.drums808, pick: (names: string[]) => string | undefined) {
    await loadSlot(name, slot, async () => {
      const instrument = pick(getDrumMachineNames());
      if (!instrument) throw new Error('no matching drum machine in this version of smplr');
      const inst = make<Sampler>(DrumMachine, sampleCtx, { instrument, destination: asNode(drumSampleBus) });
      await inst.ready;
      const groups = inst.getGroupNames?.() ?? [];
      const kick = groups.find((g) => /^kick/i.test(g));
      const snare = groups.find((g) => /^snare/i.test(g));
      const hat = groups.find((g) => /^hi-?hat.*clos/i.test(g)) ?? groups.find((g) => /^hi-?hat/i.test(g));
      if (!kick || !snare || !hat) throw new Error(`${instrument} has no kick, snare and closed hat (groups: ${groups.join(', ')})`);
      slot.value = { inst, kick, snare, hat };
    });
  }

  let loading: Promise<void> | null = null;
  const loadAll = () =>
    (loading ??= Promise.all([
      loadDrums('TR-808 drums', slots.drums808, (names) => names.find((n) => n === 'TR-808')),
      // smplr's DrumMachine has no TR-909. Use one if a newer version adds it, otherwise its Roland CR-8000.
      loadDrums('rock drums', slots.drumsRock, (names) => names.find((n) => /909/.test(n)) ?? names.find((n) => /CR-8000/i.test(n))),
      loadSlot('electric piano', slots.ep, async () => {
        const inst = make<Sampler>(ElectricPiano, sampleCtx, { instrument: 'WurlitzerEP200', destination: asNode(keysSampleGain) });
        await inst.ready;
        slots.ep.value = inst;
      }),
      loadSlot('grand piano', slots.piano, async () => {
        const inst = make<Sampler>(SplendidGrandPiano, sampleCtx, { destination: asNode(keysSampleGain), decayTime: 1.2 });
        await inst.ready;
        slots.piano.value = inst;
      }),
    ]).then(() => undefined));

  /** The sampled drums for the current preset, or null (synth drums) if the preset has none or its kit is not ready. */
  const drumKit = (): DrumSlot | null => {
    const kit = current && SAMPLE_PLAN[current].drums;
    const slot = kit === '808' ? slots.drums808 : kit === 'rock' ? slots.drumsRock : null;
    return slot && slot.state === 'ready' ? slot.value : null;
  };
  const keysKit = (): Sampler | null => {
    const kit = current && SAMPLE_PLAN[current].keys;
    const slot = kit === 'ep' ? slots.ep : kit === 'piano' ? slots.piano : null;
    return slot && slot.state === 'ready' ? slot.value : null;
  };

  let current: SoundPreset | null = null;
  let settings: PresetSettings = PRESETS.lofi;

  /** Dip the keys by the preset's duckDb at `time`, then recover over an eighth note. */
  function duckKeys(time: number) {
    if (!studio.ducking || settings.keys.duckDb >= 0) return;
    const recover = Tone.Time('8n').toSeconds();
    duck.gain.cancelScheduledValues(time);
    duck.gain.setValueAtTime(Tone.dbToGain(settings.keys.duckDb), time);
    duck.gain.linearRampToValueAtTime(1, time + recover);
  }

  const jit = () => (studio.humanize ? jitter() : 0);

  const flatten = (ev: StepEvents): StepEvents => ({
    ...ev,
    kick: ev.kick ? FLAT_VELOCITY : 0,
    snare: ev.snare ? FLAT_VELOCITY : 0,
    hat: ev.hat ? FLAT_VELOCITY : 0,
    bass: ev.bass.map((n) => ({ ...n, velocity: FLAT_VELOCITY })),
    keys: ev.keys.map((c) => ({ ...c, velocity: FLAT_VELOCITY })),
    melody: ev.melody.map((n) => ({ ...n, velocity: FLAT_VELOCITY })),
  });

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

    getStudio: () => ({ ...studio }),
    setStudio(key, on) {
      studio[key] = on;
      const ramp = STUDIO_RAMP_S;
      if (key === 'master') {
        processed.gain.rampTo(on ? 1 : 0, ramp);
        bypass.gain.rampTo(on ? 0 : 1, ramp);
      } else if (key === 'sends') {
        keysSend.gain.rampTo(on ? settings.keys.reverbWet : 0, ramp);
        melodySend.gain.rampTo(on ? settings.melody.reverbSend : 0, ramp);
        delay.wet.rampTo(on ? settings.melody.delayWet : 0, ramp);
      } else if (key === 'stereo') {
        keysPan.pan.rampTo(on ? -0.2 : 0, ramp);
        melodyPan.pan.rampTo(on ? 0.2 : 0, ramp);
      } else if (key === 'humanize') {
        Tone.getTransport().swing = on ? settings.swing : 0;
      } else if (key === 'ducking' && !on) {
        duck.gain.cancelScheduledValues(Tone.now());
        duck.gain.rampTo(1, ramp); // let go of a dip that is in progress
      }
    },
    load: loadAll,
    sampleStates: () => ({ drums808: slots.drums808.state, drumsRock: slots.drumsRock.state, ep: slots.ep.state, piano: slots.piano.state }),

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

      bass.oscillator.type = p.bass.wave as never;
      if (p.bass.wave === 'fatsawtooth') {
        const osc = bass.oscillator as unknown as { spread: number; count: number };
        osc.spread = p.bass.spread ?? 30; // the two saws pull against each other: the reese
        osc.count = 2;
      }
      bass.set({
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
      keysSampleGain.gain.value = Tone.dbToGain(p.keys.volume); // sampled keys sit at the same level as the synth they replace: no louder
      keysFilter.frequency.value = p.keys.lowpass;
      // The shared reverb: keys send level and decay come from the preset (2.5 s is the starting decay), the melody gets its own send level.
      keysSend.gain.value = studio.sends ? p.keys.reverbWet : 0;
      melodySend.gain.value = studio.sends ? p.melody.reverbSend : 0;
      const transport = Tone.getTransport();
      transport.swing = studio.humanize ? p.swing : 0;
      transport.swingSubdivision = p.swingSub ?? '16n';

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
      delay.wet.value = studio.sends ? p.melody.delayWet : 0;

      // Last, because it is the only slow part: the new decay regenerates the impulse response.
      if (reverb.decay !== p.keys.reverbDecay) {
        reverb.decay = p.keys.reverbDecay;
        await reverb.ready;
      }
    },

    play(input, time) {
      const ev = studio.humanize ? input : flatten(input); // Humanize off: every hit equally strong
      // The kick stays exactly on the grid (and the duck with it); everything else floats by up to +-8 ms.
      const dm = drumKit();
      if (ev.kick) {
        if (dm) safely('kick sample', () => dm.inst.start({ note: dm.kick, velocity: vel127(ev.kick * DRUM_TRIM.kick), time }));
        else safely('kick', () => kick.triggerAttackRelease('C1', '8n', time, ev.kick));
        safely('duck', () => duckKeys(time));
      }
      if (ev.snare) {
        if (dm) safely('snare sample', () => dm.inst.start({ note: dm.snare, velocity: vel127(ev.snare * DRUM_TRIM.snare), time: time + jit() }));
        else
          safely('snare', () => {
            const t = time + jit();
            snareNoise.triggerAttackRelease('16n', t, ev.snare);
            snareTone.triggerAttackRelease(settings.snare.toneHz, '32n', t, ev.snare);
          });
      }
      if (ev.hat) {
        if (dm) safely('hat sample', () => dm.inst.start({ note: dm.hat, velocity: vel127(ev.hat * DRUM_TRIM.hat), time: time + jit() }));
        else safely('hat', () => hat.triggerAttackRelease(settings.hat.hz, '32n', time + jit(), ev.hat));
      }
      for (const n of ev.bass) safely('bass', () => bass.triggerAttackRelease(n.note, n.dur, time + jit(), n.velocity));
      const piano = keysKit();
      for (const c of ev.keys) {
        if (piano) {
          safely('keys sample', () => {
            const t = time + jit();
            const duration = Tone.Time(c.dur).toSeconds();
            for (const note of c.notes) piano.start({ note, velocity: vel127(c.velocity), time: t, duration });
          });
        } else safely('keys', () => keys.triggerAttackRelease(c.notes, c.dur, time + jit(), c.velocity));
      }
      for (const n of ev.melody) safely('melody', () => melody.triggerAttackRelease(n.note, n.dur, time + jit(), n.velocity));
    },

    silence() {
      safely('silence', () => {
        keys.releaseAll();
        slots.ep.value?.stop();
        slots.piano.value?.stop();
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
