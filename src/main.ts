import './style.css';
import * as Tone from 'tone';
import type {
  AgentReply,
  BassBar,
  BlockParts,
  ChordBar,
  ConductorOverrides,
  ConductorReply,
  DrumBar,
  GraphPayload,
  JamState,
  MelodyBar,
} from '../shared/types';
import { TIME_SIGNATURES, meterOf, type TimeSignature } from '../shared/meter';
import { getRig } from './audio';
import { createGraphPanel, type EchoEvent } from './graph';
import { Pipeline, type Block } from './pipeline';
import { stepEvents, strongSteps } from './steps';

const BARS_PER_CHUNK = 4;
const DEFAULT_VIBE = 'dusty late-night lo-fi, sleepy but groovy';
const BPM_MIN = 60;
const BPM_MAX = 180;
/** Finished blocks kept queued ahead of the one that is playing: 2 blocks = 8 bars. */
const BUFFER_BLOCKS = 2;
/** Only the recent tail of the shared state is sent to the agents; they read the last 8 bars anyway. */
const STATE_TAIL_BARS = 16;

/** Four bars written together by the band. */
type Chunk = Block<BlockParts>;
type PartName = keyof BlockParts;
type Who = 'conductor' | PartName | 'system';
type Mode = 'idle' | 'loading' | 'playing';

/** Everything that belongs to one Start..Stop run. Replaced on every Start so stale async work can detect it was cancelled. */
interface Session {
  /** Keys this run's motifs in the band memory (Neo4j) */
  id: string;
  state: JamState;
  /** Sixteenth-note steps per bar, set from the conductor's time signature */
  stepsPerBar: number;
  /** Steps that count as beats 1 and 3 (they get an accent) */
  strong: number[];
  pipeline: Pipeline<BlockParts>;
  current: Chunk | null;
  step: number;
  bar: number;
  loopWarned: boolean;
  waitFirst?: { resolve: () => void; reject: (err: Error) => void };
}

// ---------- UI ----------

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main>
    <header>
      <h1>Agent Jam Band</h1>
      <p class="sub">A conductor sets the tempo, key and meter. Then drums, bass, keys and melody are four AI agents, each reading the ones before it.</p>
    </header>
    <section class="panel bar">
      <div class="field vibe">
        <label for="vibe">Vibe</label>
        <input id="vibe" type="text" maxlength="300" placeholder="${DEFAULT_VIBE}" autocomplete="off" />
      </div>
      <div class="field">
        <label for="bpm">BPM</label>
        <input id="bpm" type="number" inputmode="numeric" min="${BPM_MIN}" max="${BPM_MAX}" step="1" placeholder="Auto" title="Blank = the conductor picks" />
      </div>
      <div class="field">
        <label for="meter">Time</label>
        <select id="meter" title="Auto = the conductor picks">
          <option value="">Auto</option>
          ${TIME_SIGNATURES.map((t) => `<option value="${t}">${t}</option>`).join('')}
        </select>
      </div>
      <div class="actions">
        <button id="start">Start</button>
        <button id="stop" class="ghost" disabled>Stop</button>
      </div>
    </section>
    <div class="workspace">
      <div class="col-main">
        <section class="panel player">
          <dl class="meta">
            <div><dt>Tempo</dt><dd id="metaBpm">–</dd></div>
            <div><dt>Key</dt><dd id="metaKey">–</dd></div>
            <div><dt>Meter</dt><dd id="metaMeter">–</dd></div>
            <div><dt>Sound</dt><dd id="metaSound">–</dd></div>
          </dl>
          <p id="now" class="now">Press Start to hear the band.</p>
          <p id="next" class="next"></p>
        </section>
        <section class="panel chat">
          <h2>Band chat</h2>
          <ol id="log" aria-live="polite"></ol>
        </section>
      </div>
      <aside class="panel graph">
        <h2>Band memory</h2>
        <ul class="legend">
          <li><i style="background: var(--drums)"></i>Drums</li>
          <li><i style="background: var(--bass)"></i>Bass</li>
          <li><i style="background: var(--keys)"></i>Keys</li>
          <li><i style="background: var(--melody)"></i>Melody</li>
          <li><i class="echo"></i>Echo</li>
        </ul>
        <div id="graphHost" class="graph-host"></div>
      </aside>
    </div>
  </main>
`;

const vibeEl = document.querySelector<HTMLInputElement>('#vibe')!;
const bpmEl = document.querySelector<HTMLInputElement>('#bpm')!;
const meterEl = document.querySelector<HTMLSelectElement>('#meter')!;
const startBtn = document.querySelector<HTMLButtonElement>('#start')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop')!;
const nowEl = document.querySelector<HTMLParagraphElement>('#now')!;
const nextEl = document.querySelector<HTMLParagraphElement>('#next')!;
const logEl = document.querySelector<HTMLOListElement>('#log')!;
const metaBpmEl = document.querySelector<HTMLElement>('#metaBpm')!;
const metaKeyEl = document.querySelector<HTMLElement>('#metaKey')!;
const metaMeterEl = document.querySelector<HTMLElement>('#metaMeter')!;
const metaSoundEl = document.querySelector<HTMLElement>('#metaSound')!;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const graphPanel = createGraphPanel(document.querySelector<HTMLElement>('#graphHost')!, {
  drums: cssVar('--drums'),
  bass: cssVar('--bass'),
  keys: cssVar('--keys'),
  melody: cssVar('--melody'),
});

const LABEL: Record<Who, string> = { conductor: 'Conductor', drums: 'Drums', bass: 'Bass', keys: 'Keys', melody: 'Melody', system: 'System' };

function log(who: Who, text: string, tag?: string) {
  const li = document.createElement('li');
  li.className = `msg ${who}`;
  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = LABEL[who];
  head.append(name);
  if (tag) {
    const tagEl = document.createElement('span');
    tagEl.className = 'bars';
    tagEl.textContent = tag;
    head.append(tagEl);
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
  bpmEl.disabled = mode !== 'idle';
  meterEl.disabled = mode !== 'idle';
  stopBtn.disabled = mode === 'idle';
  if (mode === 'idle') {
    nowEl.textContent = 'Press Start to hear the band.';
    nextEl.textContent = '';
  } else if (mode === 'loading') {
    nowEl.textContent = 'Starting…';
    nextEl.textContent = '';
  }
}

function showSettings(state: JamState, preset: string) {
  metaBpmEl.textContent = `${state.tempo} BPM`;
  metaKeyEl.textContent = state.key;
  metaMeterEl.textContent = state.timeSignature;
  metaSoundEl.textContent = preset;
}

const barsOf = (n: number) => `${(n - 1) * BARS_PER_CHUNK + 1}–${n * BARS_PER_CHUNK}`;

function renderStatus(s: Session) {
  if (s.current) {
    nowEl.textContent = `Playing bars ${barsOf(s.current.n)} (bar ${s.bar + 1} of ${BARS_PER_CHUNK})`;
  }
  const st = s.pipeline.status();
  const buffer = `Buffered ahead: ${st.ready * BARS_PER_CHUNK} of ${BUFFER_BLOCKS * BARS_PER_CHUNK} bars`;
  const busy = st.working.map((w) => `${w.stage} for bars ${barsOf(w.n)}`);
  nextEl.textContent = busy.length ? `${buffer} · writing ${busy.join(', ')}` : buffer;
}

/** Reads the BPM box and meter dropdown. A BPM outside 60-180 is clamped into range (and the box updated); anything that is not a number counts as Auto. */
function readOverrides(): ConductorOverrides {
  const overrides: ConductorOverrides = {};
  const raw = bpmEl.value.trim();
  if (raw !== '') {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n)) {
      overrides.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, n));
      bpmEl.value = String(overrides.bpm);
    } else {
      bpmEl.value = '';
    }
  }
  if (meterEl.value) overrides.timeSignature = meterEl.value as TimeSignature;
  return overrides;
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

/** Index in the shared state of bar `i` (0-3) of block `n`. */
const barIndex = (n: number, i: number) => (n - 1) * BARS_PER_CHUNK + i;

/** One musician's turn: send the shared state plus the earlier parts, log its note, and record its bars in the shared state. */
async function runStage<T>(s: Session, who: PartName, n: number, earlier: object, record: (bars: T[]) => void): Promise<T[]> {
  const snapshot = { ...s.state, bars: s.state.bars.slice(-STATE_TAIL_BARS) };
  const reply = await post<AgentReply<T>>(`/api/agents/${who}`, { state: snapshot, ...earlier, memory: { sessionId: s.id, block: n } });
  if (session !== s) throw new Error('stopped');
  if (reply.why) log(who, reply.why, `bars ${barsOf(n)} · ${reply.latencyMs} ms`);
  record(reply.bars);
  if (reply.echoed) void refreshGraph(s); // a new ECHOES edge is on its way into the graph
  return reply.bars;
}

// ---------- Band memory graph ----------

const ECHO_NOUN: Record<string, string> = { drums: 'groove', bass: 'bassline', keys: 'chords', melody: 'hook' };

/** Chat line for a new ECHOES edge, e.g. "bringing back the melody's hook from block 2". */
function announceEcho(e: EchoEvent) {
  const who = e.from.agent as PartName | undefined;
  if (!who || !(who in LABEL) || e.to.block === undefined) return;
  const target = e.to.agent === who ? 'its own' : `the ${e.to.agent}'s`;
  const reason = e.reason && e.reason !== 'calling it back' ? ` (${e.reason})` : '';
  log(who, `bringing back ${target} ${ECHO_NOUN[e.to.agent ?? ''] ?? 'phrase'} from block ${e.to.block}${reason}`, `echo · block ${e.from.block ?? ''}`);
}

let graphBusy = false;
let graphDirty = false;

/** Fetches the session graph and hands it to the panel. Runs on every finished block (and when an agent reports a callback). Failures stay in the console. */
async function refreshGraph(s: Session) {
  if (graphBusy) {
    graphDirty = true;
    return;
  }
  graphBusy = true;
  try {
    do {
      graphDirty = false;
      const res = await fetch(`/api/graph?session=${encodeURIComponent(s.id)}`);
      if (!res.ok) break;
      const payload = (await res.json()) as GraphPayload;
      if (session !== s) break;
      for (const e of graphPanel.update(payload)) announceEcho(e);
    } while (graphDirty);
  } catch (err) {
    console.warn(`[client] could not refresh the band memory graph: ${errMsg(err)}`);
  } finally {
    graphBusy = false;
  }
}

// ---------- Transport ----------

const transport = Tone.getTransport();
let session: Session | null = null;

/** A fresh id for each Start..Stop run (letters, digits, dashes). */
function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function newSession(vibe: string): Session {
  const s: Session = {
    id: makeId(),
    // tempo, key and time signature are replaced by the conductor's answer before the pipeline starts
    state: { tempo: 90, key: 'A minor', timeSignature: '4/4', vibe, bars: [] },
    stepsPerBar: 16,
    strong: [0, 8],
    current: null,
    step: 0,
    bar: 0,
    loopWarned: false,
    pipeline: new Pipeline<BlockParts>({
      bufferBlocks: BUFFER_BLOCKS,

      // Order per block: drums -> bass -> keys -> melody. Each stage is sent every earlier part.
      stages: [
        {
          name: 'drums',
          write: (n) =>
            runStage<DrumBar>(s, 'drums', n, {}, (bars) => {
              for (const drums of bars) s.state.bars.push({ key: s.state.key, drums, bass: null, keys: null, melody: null });
            }),
        },
        {
          name: 'bass',
          write: (n, up) =>
            runStage<BassBar>(s, 'bass', n, { drums: up.drums }, (bars) => {
              bars.forEach((bass, i) => (s.state.bars[barIndex(n, i)].bass = bass));
            }),
        },
        {
          name: 'keys',
          write: (n, up) =>
            runStage<ChordBar>(s, 'keys', n, { drums: up.drums, bass: up.bass }, (bars) => {
              bars.forEach((keys, i) => (s.state.bars[barIndex(n, i)].keys = keys));
            }),
        },
        {
          name: 'melody',
          write: (n, up) =>
            runStage<MelodyBar>(s, 'melody', n, { drums: up.drums, bass: up.bass, keys: up.keys }, (bars) => {
              bars.forEach((melody, i) => (s.state.bars[barIndex(n, i)].melody = melody));
            }),
        },
      ],

      onBlockReady: () => {
        s.waitFirst?.resolve();
        void refreshGraph(s);
      },

      // Errors never reach the band chat: the console has them, the music keeps going.
      onError: (stage, n, err, willRetry) => {
        console.warn(`[client] ${stage} request for bars ${barsOf(n)} failed (${errMsg(err)}); ${willRetry ? 'retrying' : 'pausing until the next phrase'}`);
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
  const chunkSteps = s.stepsPerBar * BARS_PER_CHUNK;
  const pos = s.step % chunkSteps;

  if (pos === 0 && s.step > 0) {
    const next = s.pipeline.take(); // also kicks off generation for the freed buffer slot
    if (next) {
      s.current = next;
      s.loopWarned = false;
    } else if (!s.loopWarned) {
      s.loopWarned = true;
      console.info('[client] the next bars are not ready yet; repeating the current four');
    }
  }

  if (pos % s.stepsPerBar === 0) {
    s.bar = pos / s.stepsPerBar;
    Tone.getDraw().schedule(() => renderStatus(s), time);
  }

  getRig().play(stepEvents(s.current.parts, pos, s.stepsPerBar, s.strong), time);
  s.step += 1;
}

function logConductor(c: ConductorReply, o: ConductorOverrides) {
  if (!c.why) return; // the conductor fell back to defaults: nothing to say
  const bpm = `${c.bpm} BPM${o.bpm !== undefined ? ' (manual)' : ''}`;
  const meter = `${c.timeSignature}${o.timeSignature ? ' (manual)' : ''}`;
  log('conductor', c.why, `${bpm} · ${c.key} · ${meter} · ${c.preset} · ${c.latencyMs} ms`);
}

async function start() {
  if (session) return;
  const overrides = readOverrides();
  const vibe = vibeEl.value.trim() || DEFAULT_VIBE;
  const s = newSession(vibe);
  session = s;
  setMode('loading');
  logEl.replaceChildren();
  graphPanel.clear();
  metaBpmEl.textContent = metaKeyEl.textContent = metaMeterEl.textContent = metaSoundEl.textContent = '–';
  log('system', `Vibe: "${vibe}".`);

  try {
    await Tone.start(); // must run inside the click so the browser allows audio

    // 1. The conductor runs first on every new vibe.
    nowEl.textContent = 'The conductor is choosing tempo, key and meter…';
    const c = await post<ConductorReply>('/api/agents/conductor', { vibe, overrides, sessionId: s.id });
    if (session !== s) return;
    s.state.tempo = c.bpm;
    s.state.key = c.key;
    s.state.timeSignature = c.timeSignature;
    const meter = meterOf(c.timeSignature);
    s.stepsPerBar = meter.stepsPerBar;
    s.strong = strongSteps(meter.accentSteps);
    showSettings(s.state, c.preset);
    logConductor(c, overrides);

    // Tempo first: the delay time in the sound preset follows the bpm.
    transport.bpm.value = c.bpm;
    transport.timeSignature = [meter.numerator, meter.denominator];
    await getRig().applyPreset(c.preset);

    // 2. Then the band writes the first block (drums -> bass -> keys -> melody).
    nowEl.textContent = 'The band is writing the first four bars…';
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
    console.error(`[client] could not start: ${errMsg(err)}`);
    setMode('idle'); // back to "Press Start": no error text in the UI
    return;
  }
  if (session !== s) return;

  transport.stop();
  transport.cancel(0);
  transport.position = 0;
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
  getRig().silence();
  setMode('idle');
  log('system', 'Stopped.');
}

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', stop);
for (const el of [vibeEl, bpmEl]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void start();
  });
}
