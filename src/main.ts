import './style.css';
import * as Tone from 'tone';
import type {
  AgentReply,
  BassBar,
  BlockParts,
  ChordBar,
  ConductorOverrides,
  ConductorReply,
  ConductorSettings,
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
type Who = 'conductor' | PartName | 'system' | 'steer';
type Mode = 'idle' | 'loading' | 'playing';

/** Quick steers: the label is also the text sent to the conductor. */
const QUICK_STEERS = ['7/8', '5/4', 'half-time', 'drop', 'darker', 'genre: jazz'];

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
  /** What is sounding right now */
  active: ConductorSettings;
  /** What the band is writing for: the latest steer, which may not be playing yet */
  target: ConductorSettings;
  /** A steer that waits for the next block boundary (the first block written after it) */
  pending: ConductorSettings | null;
  /** Aborts the requests of discarded work when the listener steers */
  abort: AbortController;
  /** Bumped on every steer; replies from an older epoch are thrown away */
  epoch: number;
  /** Where each block's first bar sits in state.bars (block numbers skip after a steer, so this is not arithmetic) */
  blockStart: Map<number, number>;
  /** Step count at which the current meter began; bar positions are measured from here */
  base: number;
  steering: boolean;
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
        <section class="panel steer-panel" id="steerPanel" hidden>
          <h2>Steer the band</h2>
          <form id="steerForm" class="steer-row" autocomplete="off">
            <input id="steerText" type="text" maxlength="200" placeholder="Try: switch to 7/8, go darker, make it jazzier…" aria-label="Steer the band" />
            <button id="steerBtn" type="submit">Steer</button>
          </form>
          <div class="steer-quick" id="steerQuick">
            ${QUICK_STEERS.map((q) => `<button type="button" class="ghost" data-steer="${q}">${q}</button>`).join('')}
          </div>
          <p id="steerNote" class="steer-note"></p>
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
          <li><i class="steer"></i>Steer</li>
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
const steerPanel = document.querySelector<HTMLElement>('#steerPanel')!;
const steerForm = document.querySelector<HTMLFormElement>('#steerForm')!;
const steerText = document.querySelector<HTMLInputElement>('#steerText')!;
const steerBtn = document.querySelector<HTMLButtonElement>('#steerBtn')!;
const steerQuick = document.querySelector<HTMLElement>('#steerQuick')!;
const steerNote = document.querySelector<HTMLElement>('#steerNote')!;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const graphPanel = createGraphPanel(document.querySelector<HTMLElement>('#graphHost')!, {
  drums: cssVar('--drums'),
  bass: cssVar('--bass'),
  keys: cssVar('--keys'),
  melody: cssVar('--melody'),
});

const LABEL: Record<Who, string> = { conductor: 'Conductor', drums: 'Drums', bass: 'Bass', keys: 'Keys', melody: 'Melody', system: 'System', steer: 'You' };

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
  steerPanel.hidden = mode !== 'playing';
  if (mode !== 'playing') {
    steerText.value = '';
    steerNote.textContent = '';
  }
  setSteerBusy(false);
  if (mode === 'idle') {
    nowEl.textContent = 'Press Start to hear the band.';
    nextEl.textContent = '';
  } else if (mode === 'loading') {
    nowEl.textContent = 'Starting…';
    nextEl.textContent = '';
  }
}

function setSteerBusy(busy: boolean) {
  steerBtn.disabled = busy;
  steerText.disabled = busy;
  for (const b of steerQuick.querySelectorAll('button')) b.disabled = busy;
}

function showSettings(c: ConductorSettings) {
  metaBpmEl.textContent = `${c.bpm} BPM`;
  metaKeyEl.textContent = c.key;
  metaMeterEl.textContent = c.timeSignature;
  metaSoundEl.textContent = c.preset;
}

const barsOf = (n: number) => `${(n - 1) * BARS_PER_CHUNK + 1}–${n * BARS_PER_CHUNK}`;

function renderStatus(s: Session) {
  if (s.current) {
    nowEl.textContent = `Playing bars ${barsOf(s.current.n)} (bar ${s.bar + 1} of ${BARS_PER_CHUNK})`;
  }
  const st = s.pipeline.status();
  const buffer = `Buffered ahead: ${st.ready * BARS_PER_CHUNK} of ${BUFFER_BLOCKS * BARS_PER_CHUNK} bars`;
  const busy = st.working.map((w) => `${w.stage} for bars ${barsOf(w.n)}`);
  const lead = s.pending ? `Switching to ${s.pending.timeSignature} · ${s.pending.bpm} BPM · ${s.pending.preset} at the next block · ` : '';
  nextEl.textContent = lead + (busy.length ? `${buffer} · writing ${busy.join(', ')}` : buffer);
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

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Bar `i` (0-3) of block `n` in the shared state. Throws if the block was discarded by a steer. */
function barOf(s: Session, n: number, i: number) {
  const start = s.blockStart.get(n);
  const bar = start === undefined ? undefined : s.state.bars[start + i];
  if (!bar) throw new Error('stopped');
  return bar;
}

/** One musician's turn: send the shared state plus the earlier parts, log its note, and record its bars in the shared state. */
async function runStage<T>(s: Session, who: PartName, n: number, earlier: object, record: (bars: T[]) => void): Promise<T[]> {
  const snapshot = { ...s.state, bars: s.state.bars.slice(-STATE_TAIL_BARS) };
  const epoch = s.epoch;
  const reply = await post<AgentReply<T>>(`/api/agents/${who}`, { state: snapshot, ...earlier, memory: { sessionId: s.id, block: n } }, s.abort.signal);
  if (session !== s || s.epoch !== epoch) throw new Error('stopped'); // stopped, or steered away from while this was being written
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
const DEFAULT_SETTINGS: ConductorSettings = { bpm: 90, key: 'A minor', timeSignature: '4/4', preset: 'lofi' };
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
    active: { ...DEFAULT_SETTINGS },
    target: { ...DEFAULT_SETTINGS },
    pending: null,
    abort: new AbortController(),
    epoch: 0,
    blockStart: new Map(),
    base: 0,
    steering: false,
    pipeline: new Pipeline<BlockParts>({
      bufferBlocks: BUFFER_BLOCKS,

      // Order per block: drums -> bass -> keys -> melody. Each stage is sent every earlier part.
      stages: [
        {
          name: 'drums',
          write: (n) =>
            runStage<DrumBar>(s, 'drums', n, {}, (bars) => {
              s.blockStart.set(n, s.state.bars.length);
              for (const drums of bars) s.state.bars.push({ key: s.state.key, timeSignature: s.state.timeSignature, drums, bass: null, keys: null, melody: null });
            }),
        },
        {
          name: 'bass',
          write: (n, up) =>
            runStage<BassBar>(s, 'bass', n, { drums: up.drums }, (bars) => {
              bars.forEach((bass, i) => (barOf(s, n, i).bass = bass));
            }),
        },
        {
          name: 'keys',
          write: (n, up) =>
            runStage<ChordBar>(s, 'keys', n, { drums: up.drums, bass: up.bass }, (bars) => {
              bars.forEach((keys, i) => (barOf(s, n, i).keys = keys));
            }),
        },
        {
          name: 'melody',
          write: (n, up) =>
            runStage<MelodyBar>(s, 'melody', n, { drums: up.drums, bass: up.bass, keys: up.keys }, (bars) => {
              bars.forEach((melody, i) => (barOf(s, n, i).melody = melody));
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
  const rel = s.step - s.base;
  let pos = rel % chunkSteps;

  if (pos === 0 && rel > 0) {
    const next = s.pipeline.take(); // also kicks off generation for the freed buffer slot
    if (next) {
      s.current = next;
      s.loopWarned = false;
      // A steer waits for exactly this moment: the first bar line where a block written for the new direction is ready.
      if (s.pending) {
        applyPending(s, time);
        pos = 0;
      }
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

/** Switches the sounding settings at a block boundary (called from tick, so `time` is the audio time of the first step of the new block). Never mid-bar. */
function applyPending(s: Session, time: number) {
  const p = s.pending;
  if (!p) return;
  s.pending = null;
  const meter = meterOf(p.timeSignature);
  transport.bpm.setValueAtTime(p.bpm, time); // exactly at the bar line, not "now"
  transport.timeSignature = [meter.numerator, meter.denominator];
  void getRig().applyPreset(p.preset, p.bpm);
  s.stepsPerBar = meter.stepsPerBar;
  s.strong = strongSteps(meter.accentSteps);
  s.base = s.step;
  s.active = p;
  Tone.getDraw().schedule(() => {
    if (session !== s) return;
    showSettings(p);
    steerNote.textContent = `Now playing ${p.timeSignature} · ${p.bpm} BPM · ${p.key} · ${p.preset}.`;
    log('system', `Switched to ${p.timeSignature} · ${p.bpm} BPM · ${p.key} · ${p.preset}.`);
    renderStatus(s);
  }, time);
}

/** Throws away everything unplayed (it was written for the old direction) and cancels the requests still in flight. Returns the discarded block numbers. */
function resetGeneration(s: Session): number[] {
  s.abort.abort();
  s.abort = new AbortController();
  s.epoch += 1;
  const dropped = s.pipeline.reset();
  const starts = dropped.flatMap((n) => (s.blockStart.has(n) ? [s.blockStart.get(n)!] : []));
  if (starts.length) s.state.bars.length = Math.min(s.state.bars.length, Math.min(...starts));
  for (const n of dropped) s.blockStart.delete(n);
  return dropped;
}

/** Live steering: ask the conductor, then change direction at the next block boundary. */
async function steer(raw: string) {
  const s = session;
  const text = raw.trim().slice(0, 200);
  if (!s || !s.current || s.steering || !text) return;
  s.steering = true;
  setSteerBusy(true);
  steerText.value = '';
  log('steer', text, `block ${s.current.n}`);
  steerNote.textContent = 'The conductor is thinking…';
  try {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const out = await post<ConductorReply>('/api/agents/conductor', {
      vibe: s.state.vibe,
      sessionId: s.id,
      steer: { id, text, atBlock: s.current.n, current: s.target },
    });
    if (session !== s) return;
    if (!out.why) {
      log('conductor', "Got it. We'll keep going as we are.", 'no change');
      steerNote.textContent = '';
      return;
    }
    const next: ConductorSettings = { bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(out.bpm))), key: out.key, timeSignature: out.timeSignature, preset: out.preset };
    s.target = next;
    s.state.tempo = next.bpm;
    s.state.key = next.key;
    s.state.timeSignature = next.timeSignature;
    s.state.steer = { text, direction: out.why };
    s.pending = next;
    const dropped = resetGeneration(s);
    s.pipeline.start(); // writes new blocks for the new direction
    log('conductor', out.why, `steer · ${next.bpm} BPM · ${next.key} · ${next.timeSignature} · ${next.preset} · ${out.latencyMs} ms`);
    steerNote.textContent = 'Changing at the next block boundary…';
    renderStatus(s);
    const done = dropped.length ? post('/api/memory/discard', { sessionId: s.id, blocks: dropped }).catch((e) => console.warn(`[client] discard failed: ${errMsg(e)}`)) : Promise.resolve();
    void done.finally(() => refreshGraph(s));
  } catch (err) {
    console.warn(`[client] steer failed: ${errMsg(err)}`);
    steerNote.textContent = '';
  } finally {
    s.steering = false;
    if (session === s) setSteerBusy(false);
  }
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
    s.active = s.target = { bpm: c.bpm, key: c.key, timeSignature: c.timeSignature, preset: c.preset };
    showSettings(s.active);
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
  s.abort.abort();
  s.waitFirst?.reject(new Error('stopped'));
  transport.stop();
  transport.cancel(0);
  getRig().silence();
  setMode('idle');
  log('system', 'Stopped.');
}

steerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void steer(steerText.value);
});
steerQuick.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-steer]');
  if (btn) void steer(btn.dataset.steer ?? '');
});
startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', stop);
for (const el of [vibeEl, bpmEl]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void start();
  });
}
