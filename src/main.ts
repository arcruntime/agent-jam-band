import './style.css';
import * as Tone from 'tone';
import type { AgentReply, BassBar, DrumBar, JamState } from '../shared/types';
import { Pipeline, type Block } from './pipeline';

const TEMPO = 90;
const KEY = 'A minor';
const STEPS_PER_BAR = 16;
const BARS_PER_CHUNK = 4;
const CHUNK_STEPS = STEPS_PER_BAR * BARS_PER_CHUNK;
const DEFAULT_VIBE = 'dusty late-night lo-fi, sleepy but groovy';
/** Finished blocks kept queued ahead of the one that is playing: 2 blocks = 8 bars. */
const BUFFER_BLOCKS = 2;
/** Only the recent tail of the shared state is sent to the agents; they read the last 8 bars anyway. */
const STATE_TAIL_BARS = 16;

/** Four bars written together by the band. */
type Chunk = Block<DrumBar[], BassBar[]>;

/** Everything that belongs to one Start..Stop run. Replaced on every Start so stale async work can detect it was cancelled. */
interface Session {
  state: JamState;
  pipeline: Pipeline<DrumBar[], BassBar[]>;
  current: Chunk | null;
  step: number;
  bar: number;
  loopWarned: boolean;
  waitFirst?: { resolve: () => void; reject: (err: Error) => void };
}

type Who = 'drums' | 'bass' | 'system';
type Mode = 'idle' | 'loading' | 'playing';

// ---------- UI ----------

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main>
    <header>
      <h1>Agent Jam Band</h1>
      <p class="sub">Two AI agents, one groove. The bassist reads the drummer's bars and locks to the kick.</p>
    </header>
    <div class="layout">
      <section class="panel player">
        <label for="vibe">Vibe</label>
        <input id="vibe" type="text" maxlength="300" placeholder="${DEFAULT_VIBE}" autocomplete="off" />
        <div class="row">
          <button id="start">Start</button>
          <button id="stop" class="ghost" disabled>Stop</button>
        </div>
        <dl class="meta">
          <div><dt>Tempo</dt><dd>${TEMPO} BPM</dd></div>
          <div><dt>Key</dt><dd>${KEY}</dd></div>
        </dl>
        <p id="now" class="now">Press Start to hear the band.</p>
        <p id="next" class="next"></p>
      </section>
      <section class="panel chat">
        <h2>Band chat</h2>
        <ol id="log" aria-live="polite"></ol>
      </section>
    </div>
  </main>
`;

const vibeEl = document.querySelector<HTMLInputElement>('#vibe')!;
const startBtn = document.querySelector<HTMLButtonElement>('#start')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop')!;
const nowEl = document.querySelector<HTMLParagraphElement>('#now')!;
const nextEl = document.querySelector<HTMLParagraphElement>('#next')!;
const logEl = document.querySelector<HTMLOListElement>('#log')!;

const LABEL: Record<Who, string> = { drums: 'Drums', bass: 'Bass', system: 'System' };

function log(who: Who, text: string, bars?: string) {
  const li = document.createElement('li');
  li.className = `msg ${who}`;
  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = LABEL[who];
  head.append(name);
  if (bars) {
    const tag = document.createElement('span');
    tag.className = 'bars';
    tag.textContent = bars;
    head.append(tag);
  }
  const p = document.createElement('p');
  p.textContent = text; // agent text is untrusted: never innerHTML
  li.append(head, p);
  logEl.append(li);
  logEl.scrollTop = logEl.scrollHeight;
}

function setMode(mode: Mode) {
  startBtn.disabled = mode !== 'idle';
  vibeEl.disabled = mode !== 'idle';
  stopBtn.disabled = mode === 'idle';
  if (mode === 'idle') {
    nowEl.textContent = 'Press Start to hear the band.';
    nextEl.textContent = '';
  } else if (mode === 'loading') {
    nowEl.textContent = 'The band is writing the first four bars…';
    nextEl.textContent = '';
  }
}

const barsOf = (n: number) => `${(n - 1) * BARS_PER_CHUNK + 1}–${n * BARS_PER_CHUNK}`;

function renderStatus(s: Session) {
  if (s.current) {
    nowEl.textContent = `Playing bars ${barsOf(s.current.n)} (bar ${s.bar + 1} of ${BARS_PER_CHUNK})`;
  }
  const st = s.pipeline.status();
  const busy: string[] = [];
  if (st.bassN !== null) busy.push(`bass for bars ${barsOf(st.bassN)}`);
  if (st.drumsN !== null) busy.push(`drums for bars ${barsOf(st.drumsN)}`);
  const buffer = `Buffered ahead: ${st.ready * BARS_PER_CHUNK} of ${BUFFER_BLOCKS * BARS_PER_CHUNK} bars`;
  nextEl.textContent = busy.length ? `${buffer} · writing ${busy.join(' and ')}` : buffer;
}

// ---------- Instruments ----------

interface Instruments {
  kick: Tone.MembraneSynth;
  snare: Tone.NoiseSynth;
  hat: Tone.NoiseSynth;
  bass: Tone.MonoSynth;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
  if (instruments) return instruments;
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
    volume: -4,
  }).toDestination();
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
    volume: -12,
  }).connect(new Tone.Filter(1500, 'highpass').toDestination());
  const hat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0 },
    volume: -22,
  }).connect(new Tone.Filter(7000, 'highpass').toDestination());
  const bass = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15 },
    filter: { Q: 2, type: 'lowpass', rolloff: -24 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 120, octaves: 3 },
    volume: -6,
  }).toDestination();
  instruments = { kick, snare, hat, bass };
  return instruments;
}

function playStep(chunk: Chunk, pos: number, time: number) {
  const { kick, snare, hat, bass } = getInstruments();
  const bar = Math.floor(pos / STEPS_PER_BAR);
  const i = pos % STEPS_PER_BAR;
  const d = chunk.drums[bar];
  if (d.kick[i]) kick.triggerAttackRelease('C1', '8n', time);
  if (d.snare[i]) snare.triggerAttackRelease('16n', time);
  if (d.hat[i]) hat.triggerAttackRelease('32n', time);
  for (const n of chunk.bass[bar]) {
    if (n.step === i) bass.triggerAttackRelease(n.note, n.dur, time);
  }
}

// ---------- Talking to the agents ----------

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function logAgent(who: 'drums' | 'bass', n: number, reply: AgentReply<unknown>) {
  log(who, reply.why, `bars ${barsOf(n)} · ${reply.latencyMs} ms`);
}

// ---------- Transport ----------

const transport = Tone.getTransport();
let session: Session | null = null;

function newSession(vibe: string): Session {
  const s: Session = {
    state: { tempo: TEMPO, key: KEY, vibe, bars: [] },
    current: null,
    step: 0,
    bar: 0,
    loopWarned: false,
    pipeline: new Pipeline<DrumBar[], BassBar[]>({
      bufferBlocks: BUFFER_BLOCKS,

      // Stage 1: the drummer reads the shared state and appends its four bars (bass still null).
      writeDrums: async (n) => {
        const snapshot = { ...s.state, bars: s.state.bars.slice(-STATE_TAIL_BARS) };
        const reply = await post<AgentReply<DrumBar>>('/api/agents/drums', { state: snapshot });
        if (session !== s) throw new Error('stopped');
        logAgent('drums', n, reply);
        for (const drums of reply.bars) s.state.bars.push({ drums, bass: null });
        return reply.bars;
      },

      // Stage 2: the bassist gets those drum bars and fills in the matching bass bars.
      writeBass: async (n, drums) => {
        const snapshot = { ...s.state, bars: s.state.bars.slice(-STATE_TAIL_BARS) };
        const reply = await post<AgentReply<BassBar>>('/api/agents/bass', { state: snapshot, drums });
        if (session !== s) throw new Error('stopped');
        logAgent('bass', n, reply);
        reply.bars.forEach((bass, i) => {
          s.state.bars[(n - 1) * BARS_PER_CHUNK + i].bass = bass;
        });
        return reply.bars;
      },

      onBlockReady: () => s.waitFirst?.resolve(),

      onError: (stage, n, err, willRetry) => {
        log('system', `The ${stage} agent failed for bars ${barsOf(n)} (${errMsg(err)}). ${willRetry ? 'Trying again…' : 'Pausing; I will try again at the next phrase.'}`);
        if (!willRetry) s.waitFirst?.reject(new Error(errMsg(err)));
      },

      onChange: () => {
        if (session === s) renderStatus(s);
      },
    }),
  };
  return s;
}

/** Runs on every 16th note, ahead of the audio clock. `time` is the exact audio time for this step. */
function tick(s: Session, time: number) {
  if (session !== s || !s.current) return;
  const pos = s.step % CHUNK_STEPS;

  if (pos === 0 && s.step > 0) {
    const next = s.pipeline.take(); // also kicks off generation for the freed buffer slot
    if (next) {
      s.current = next;
      s.loopWarned = false;
    } else if (!s.loopWarned) {
      s.loopWarned = true;
      Tone.getDraw().schedule(() => log('system', 'The next bars are not ready yet, so the current four repeat to keep the music going.'), time);
    }
  }

  if (pos % STEPS_PER_BAR === 0) {
    s.bar = Math.floor(pos / STEPS_PER_BAR);
    Tone.getDraw().schedule(() => renderStatus(s), time);
  }

  playStep(s.current, pos, time);
  s.step += 1;
}

async function start() {
  if (session) return;
  const vibe = vibeEl.value.trim() || DEFAULT_VIBE;
  const s = newSession(vibe);
  session = s;
  setMode('loading');
  logEl.replaceChildren();
  log('system', `Vibe: "${vibe}". ${TEMPO} BPM, ${KEY}.`);

  try {
    await Tone.start(); // must run inside the click so the browser allows audio
    getInstruments();
    await new Promise<void>((resolve, reject) => {
      s.waitFirst = { resolve, reject };
      s.pipeline.start();
    });
    s.waitFirst = undefined;
    s.current = s.pipeline.take() ?? null;
    if (!s.current) throw new Error('the first bars went missing');
  } catch (err) {
    if (session !== s) return;
    s.pipeline.stop();
    session = null;
    log('system', `Couldn't start: ${errMsg(err)}`);
    setMode('idle');
    return;
  }
  if (session !== s) return;

  transport.stop();
  transport.cancel(0);
  transport.position = 0;
  transport.bpm.value = TEMPO;
  transport.scheduleRepeat((time) => tick(s, time), '16n');
  transport.start('+0.1');
  setMode('playing');
  renderStatus(s);
}

function stop() {
  if (!session) return;
  const s = session;
  session = null;
  s.pipeline.stop();
  s.waitFirst?.reject(new Error('stopped'));
  transport.stop();
  transport.cancel(0);
  setMode('idle');
  log('system', 'Stopped.');
}

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', stop);
vibeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void start();
});
