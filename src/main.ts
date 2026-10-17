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
  TokenUsage,
} from '../shared/types';
import { defaultArrangement, describeArrangement, reharmonize, sanitizeArrangement, sectionStart, slotsOf, type Arrangement, type BlockSlot, type SectionName } from '../shared/arrangement';
import { TIME_SIGNATURES, meterOf, type TimeSignature } from '../shared/meter';
import { getRig, type StudioKey } from './audio';
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

/** Who gets a token counter. */
const TOKEN_AGENTS = ['conductor', 'drums', 'bass', 'keys', 'melody'] as const;

/** The Studio switches, each with a one-line plain explanation. */
const STUDIO_TOOLS: { key: StudioKey; name: string; why: string }[] = [
  { key: 'master', name: 'Master bus', why: 'EQ, compressor and limiter glue the mix and stop clipping. Off: raw and louder.' },
  { key: 'humanize', name: 'Humanize', why: 'Swing, timing wobble and varied hit strength. Off: a rigid grid, every hit equal.' },
  { key: 'ducking', name: 'Ducking', why: 'Keys dip when the kick hits, creating the pumping feel.' },
  { key: 'sends', name: 'Reverb & delay', why: 'Keys and melody share a room; melody gets an echo. Off: dry and close.' },
  { key: 'stereo', name: 'Panning', why: 'Keys a little left, melody a little right. Off: everything dead center (mono).' },
];

/** Quick steers: the label is also the text sent to the conductor. */
const QUICK_STEERS = ['7/8', '5/4', 'half-time', 'drop', 'breakdown', 'darker', 'genre: jazz'];

/** Where one block sits in the song. */
interface Planned {
  /** Index into the session's slots (the arrangement cut into 4-bar blocks) */
  pos: number;
  slot: BlockSlot;
  /** Song bar (1-based, counted through every loop) this block starts on, and the bar its section instance started on */
  startBar: number;
  sectionStartBar: number;
}

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
  /** Beats in a bar (the time signature's top number) and sixteenth steps per beat, for the beat counter */
  beats: number;
  stepsPerBeat: number;
  steering: boolean;
  /** The song structure the conductor planned, and the same cut into 4-bar blocks */
  arrangement: Arrangement;
  slots: BlockSlot[];
  /** The song position of every block written or playing, by block number (numbers skip after a steer, so this is not arithmetic) */
  plans: Map<number, Planned>;
  /** Which slot and which song bar the next block to be written gets */
  nextPos: number;
  nextBar: number;
  /** The song bar of the section instance last announced in the chat, and the block the header is showing (it follows the audio, not the scheduler) */
  shownSection: number;
  shownBlock: number;
  waitFirst?: { resolve: () => void; reject: (err: Error) => void };
}

// ---------- UI ----------

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main class="stage">
    <header class="top">
      <div class="toprow">
        <h1>Agent Jam Band</h1>
        <div class="field vibe">
          <label for="vibe">Vibe</label>
          <input id="vibe" type="text" maxlength="300" placeholder="${DEFAULT_VIBE}" autocomplete="off" />
        </div>
        <div class="field small">
          <label for="bpm">BPM</label>
          <input id="bpm" type="number" inputmode="numeric" min="${BPM_MIN}" max="${BPM_MAX}" step="1" placeholder="Auto" title="Blank = the conductor picks" />
        </div>
        <div class="field small">
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
      </div>
      <div class="statusrow">
        <dl class="meta">
          <div><dt>Tempo</dt><dd id="metaBpm">–</dd></div>
          <div><dt>Key</dt><dd id="metaKey">–</dd></div>
          <div><dt>Meter</dt><dd id="metaMeter">–</dd></div>
          <div><dt>Sound</dt><dd id="metaSound">–</dd></div>
        </dl>
        <div class="beat" id="beat" role="img" aria-label="Beat counter">
          <div class="beat-num" id="beatNum">–</div>
          <div class="beat-pips" id="beatPips"></div>
        </div>
        <div class="section" id="section" aria-live="polite">
          <span class="sec-label">Section</span>
          <b class="sec-name" id="secName">–</b>
          <span class="sec-bar" id="secBar"></span>
        </div>
        <div class="tokens" id="tokens" title="Tokens used this session, from the model's usage reports">
          <div class="tok total"><span>Tokens</span><b id="tokTotal">0</b></div>
          ${TOKEN_AGENTS.map((a) => `<div class="tok" data-agent="${a}"><span>${a}</span><b>0</b></div>`).join('')}
        </div>
        <div class="nowbox">
          <p id="now" class="now">Warming up the band…</p>
          <p id="next" class="next"></p>
        </div>
      </div>
    </header>
    <div class="split">
      <div class="left">
        <section class="panel chat">
          <h2>Band chat</h2>
          <ol id="log" aria-live="polite"></ol>
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
      </div>
      <div class="right">
        <aside class="panel graph">
          <div class="panel-head">
            <h2>Band memory</h2>
            <button type="button" id="legendBtn" class="info" aria-label="What am I looking at?" aria-expanded="false" aria-controls="legendPop">ⓘ</button>
          </div>
          <div id="legendPop" class="legend-pop" role="note" hidden>
            <ul>
              <li><i class="k-agent"></i><span><b>Big dots</b> are the agents: drums, bass, keys and melody, each in its own color</span></li>
              <li><i class="k-motif"></i><span><b>Small colored dots</b> are motifs, the phrases an agent played</span></li>
              <li><i class="k-block"></i><span><b>Grey</b> dots are blocks, four bars each</span></li>
              <li><i class="k-echo"></i><span><b>White lines</b> are ECHOES: an agent called back another's idea</span></li>
              <li><i class="k-locks"></i><span><b>Dashed</b> lines are LOCKS_TO: playing in sync</span></li>
              <li><i class="k-steer"></i><span><b>Diamond</b> is a steer you gave the band</span></li>
              <li><i class="k-section"></i><span><b>Rounded square</b> is a song section: intro, build, drop or breakdown</span></li>
            </ul>
            <p>The band's memory grows as they listen and call back each other's ideas.</p>
          </div>
          <div id="graphHost" class="graph-host"></div>
        </aside>
        <section class="panel studio" id="studio">
          <h2>Studio: switch it off to hear what it does</h2>
          <ul class="studio-list">
            ${STUDIO_TOOLS.map(
              (t) => `<li class="studio-item">
              <button type="button" class="sw" role="switch" aria-checked="true" data-studio="${t.key}" aria-label="${t.name}">ON</button>
              <span class="studio-name">${t.name}</span>
              <p class="studio-why">${t.why}</p>
            </li>`,
            ).join('')}
          </ul>
        </section>
      </div>
    </div>
    <footer class="credits">Sampled sounds via smplr · Wurlitzer EP200 by Greg Sullivan (CC BY 3.0) · drum machines from smpldsnds/drum-machines · grand piano from sfzinstruments/SplendidGrandPiano · see README for licenses</footer>
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
const beatEl = document.querySelector<HTMLElement>('#beat')!;
const beatNumEl = document.querySelector<HTMLElement>('#beatNum')!;
const beatPipsEl = document.querySelector<HTMLElement>('#beatPips')!;
const sectionEl = document.querySelector<HTMLElement>('#section')!;
const secNameEl = document.querySelector<HTMLElement>('#secName')!;
const secBarEl = document.querySelector<HTMLElement>('#secBar')!;
const legendBtn = document.querySelector<HTMLButtonElement>('#legendBtn')!;
const legendPop = document.querySelector<HTMLElement>('#legendPop')!;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const graphPanel = createGraphPanel(document.querySelector<HTMLElement>('#graphHost')!, {
  drums: cssVar('--drums'),
  bass: cssVar('--bass'),
  keys: cssVar('--keys'),
  melody: cssVar('--melody'),
});

// ---------- Token counters ----------

const tokTotalEl = document.querySelector<HTMLElement>('#tokTotal')!;
const tokEls = new Map<string, HTMLElement>(TOKEN_AGENTS.map((a) => [a, document.querySelector<HTMLElement>(`.tok[data-agent="${a}"] b`)!]));
const tokens = new Map<string, number>();
const fmtTokens = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Adds one reply's reported usage to its agent's counter and the session total. A reply without usage adds nothing. */
function addTokens(agent: string, usage?: TokenUsage) {
  const n = usage?.total ?? 0;
  if (!n || !tokEls.has(agent)) return;
  tokens.set(agent, (tokens.get(agent) ?? 0) + n);
  tokEls.get(agent)!.textContent = fmtTokens(tokens.get(agent)!);
  let sum = 0;
  for (const v of tokens.values()) sum += v;
  tokTotalEl.textContent = fmtTokens(sum);
}

function resetTokens() {
  tokens.clear();
  for (const el of tokEls.values()) el.textContent = '0';
  tokTotalEl.textContent = '0';
}

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

/** False until every sampled instrument has loaded (or failed over to its synth). Start stays disabled until then. */
let warm = false;

function setMode(mode: Mode) {
  startBtn.disabled = mode !== 'idle' || !warm;
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
    nowEl.textContent = warm ? 'Press Start to hear the band.' : 'Warming up the band…';
    nextEl.textContent = '';
    clearBeat();
    clearSection();
  } else if (mode === 'loading') {
    nowEl.textContent = 'Starting…';
    nextEl.textContent = '';
  }
}

// ---------- Beat counter ----------

let pipTotal = 0;

/** Shows beat `beat` (1-based) of a bar with `total` beats: a big number plus one pip per beat, with beat 1 in its own colour. A meter change rebuilds the pips. */
function renderBeat(beat: number, total: number) {
  if (total !== pipTotal) {
    pipTotal = total;
    beatPipsEl.replaceChildren(
      ...Array.from({ length: total }, (_, i) => {
        const pip = document.createElement('i');
        pip.className = i === 0 ? 'pip one' : 'pip';
        return pip;
      }),
    );
  }
  [...beatPipsEl.children].forEach((pip, i) => pip.classList.toggle('on', i === beat - 1));
  beatNumEl.textContent = String(beat);
  beatEl.classList.toggle('downbeat', beat === 1);
  beatEl.setAttribute('aria-label', `Beat ${beat} of ${total}`);
}

function clearBeat() {
  pipTotal = 0;
  beatPipsEl.replaceChildren();
  beatNumEl.textContent = '–';
  beatEl.classList.remove('downbeat');
}

// ---------- Song section ----------

function clearSection() {
  secNameEl.textContent = '–';
  secBarEl.textContent = '';
  delete sectionEl.dataset.section;
}

/** Header: the section of the block that is playing and the bar within it. */
function renderSection(s: Session) {
  const plan = s.plans.get(s.shownBlock);
  if (!plan) return;
  secNameEl.textContent = plan.slot.section;
  secBarEl.textContent = `bar ${plan.slot.sectionBar + s.bar} of ${plan.slot.sectionBars}`;
  sectionEl.dataset.section = plan.slot.section;
}

/** A block just started playing: if it opens a new section (a new instance, so a second drop counts), flash the header and say so in the chat. */
function announceSection(s: Session, n: number) {
  const plan = s.plans.get(n);
  if (!plan) return;
  s.shownBlock = n;
  renderSection(s);
  if (plan.sectionStartBar === s.shownSection) return;
  s.shownSection = plan.sectionStartBar;
  sectionEl.classList.remove('flash');
  void sectionEl.offsetWidth; // restart the animation
  sectionEl.classList.add('flash');
  log('system', `Section: ${plan.slot.section} (${plan.slot.sectionBars} bars)`);
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
  renderSection(s);
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

/** Gives block n its place in the song. Blocks are written in order, so each new one takes the next slot of the arrangement (the song loops). */
function planFor(s: Session, n: number): Planned {
  const known = s.plans.get(n);
  if (known) return known;
  const pos = s.nextPos % s.slots.length;
  const slot = s.slots[pos];
  const plan: Planned = { pos, slot, startBar: s.nextBar, sectionStartBar: s.nextBar - (slot.sectionBar - 1) };
  s.plans.set(n, plan);
  s.nextPos = (pos + 1) % s.slots.length;
  s.nextBar += BARS_PER_CHUNK;
  return plan;
}

/** After a steer threw the unplayed blocks away: the next block to write follows the one that is playing, or starts the section the listener asked for. */
function continueSong(s: Session, jump: SectionName | null) {
  const cur = s.current ? s.plans.get(s.current.n) : undefined;
  if (cur) {
    s.nextPos = (cur.pos + 1) % s.slots.length;
    s.nextBar = cur.startBar + BARS_PER_CHUNK;
  }
  // Already in that section: carry on with the song instead of restarting it.
  if (jump && cur?.slot.section !== jump) s.nextPos = sectionStart(s.slots, jump, s.nextPos) ?? s.nextPos;
}

/** One musician's turn: send the shared state plus the earlier parts, log its note, and record its bars in the shared state. */
async function runStage<T>(s: Session, who: PartName, n: number, earlier: object, record: (bars: T[]) => void): Promise<T[]> {
  const snapshot = { ...s.state, bars: s.state.bars.slice(-STATE_TAIL_BARS) };
  const epoch = s.epoch;
  // The drummer opens each block, so it is the one that gives the block its place in the song; the others find it there.
  const planned = who === 'drums' ? planFor(s, n) : s.plans.get(n);
  if (!planned) throw new Error('stopped');
  const { slot } = planned;
  const body = {
    state: snapshot,
    ...earlier,
    memory: { sessionId: s.id, block: n, section: { name: slot.section, startBar: planned.sectionStartBar } },
    plan: { section: slot.section, sectionBar: slot.sectionBar, sectionBars: slot.sectionBars, chords: slot.chords },
  };
  const reply = await post<AgentReply<T>>(`/api/agents/${who}`, body, s.abort.signal);
  if (session !== s || s.epoch !== epoch) throw new Error('stopped'); // stopped, or steered away from while this was being written
  addTokens(who, reply.tokens);
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
    beats: 4,
    stepsPerBeat: 4,
    steering: false,
    arrangement: defaultArrangement(DEFAULT_SETTINGS.key),
    slots: slotsOf(defaultArrangement(DEFAULT_SETTINGS.key)),
    plans: new Map(),
    nextPos: 0,
    nextBar: 1,
    shownSection: 0,
    shownBlock: 0,
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
      const n = next.n;
      Tone.getDraw().schedule(() => {
        if (session === s) announceSection(s, n);
      }, time);
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

  // Beat counter: on every beat of the bar (a quarter note in x/4, an eighth in x/8), timed to the audio like everything else.
  const inBar = pos % s.stepsPerBar;
  if (inBar % s.stepsPerBeat === 0) {
    const beat = inBar / s.stepsPerBeat + 1;
    const total = s.beats;
    Tone.getDraw().schedule(() => {
      if (session !== s) return;
      renderBeat(beat, total);
      if (beat === 1) graphPanel.beat(1);
    }, time);
  }

  const ev = stepEvents(s.current.parts, pos, s.stepsPerBar, s.strong);
  const sounding: string[] = [];
  if (ev.kick || ev.snare || ev.hat) sounding.push('drums');
  if (ev.bass.length) sounding.push('bass');
  if (ev.keys.length) sounding.push('keys');
  if (ev.melody.length) sounding.push('melody');
  if (sounding.length) {
    Tone.getDraw().schedule(() => {
      if (session === s) for (const a of sounding) graphPanel.flash(a);
    }, time);
  }
  getRig().play(ev, time);
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
  s.beats = meter.numerator;
  s.stepsPerBeat = 16 / meter.denominator;
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
  for (const n of dropped) {
    s.blockStart.delete(n);
    s.plans.delete(n);
  }
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
    addTokens('conductor', out.tokens);
    if (!out.why) {
      log('conductor', "Got it. We'll keep going as we are.", 'no change');
      steerNote.textContent = '';
      return;
    }
    const prevKey = s.target.key;
    const next: ConductorSettings = { bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(out.bpm))), key: out.key, timeSignature: out.timeSignature, preset: out.preset };
    s.target = next;
    s.state.tempo = next.bpm;
    s.state.key = next.key;
    s.state.timeSignature = next.timeSignature;
    s.state.steer = { text, direction: out.why };
    s.pending = next;
    // A new key means the planned chords would clash: same sections, new chords.
    if (next.key !== prevKey) {
      s.arrangement = reharmonize(s.arrangement, next.key);
      s.slots = slotsOf(s.arrangement);
    }
    const jump = out.section && s.slots.some((sl) => sl.section === out.section) ? out.section : null;
    const dropped = resetGeneration(s);
    continueSong(s, jump);
    s.pipeline.start(); // writes new blocks for the new direction
    log('conductor', out.why, `steer · ${next.bpm} BPM · ${next.key} · ${next.timeSignature} · ${next.preset}${jump ? ` · to the ${jump}` : ''} · ${out.latencyMs} ms`);
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
  if (session || !warm) return;
  const overrides = readOverrides();
  const vibe = vibeEl.value.trim() || DEFAULT_VIBE;
  const s = newSession(vibe);
  session = s;
  setMode('loading');
  logEl.replaceChildren();
  graphPanel.clear();
  resetTokens();
  metaBpmEl.textContent = metaKeyEl.textContent = metaMeterEl.textContent = metaSoundEl.textContent = '–';
  log('system', `Vibe: "${vibe}".`);

  try {
    await Tone.start(); // must run inside the click so the browser allows audio

    // 1. The conductor runs first on every new vibe.
    nowEl.textContent = 'The conductor is choosing tempo, key and meter…';
    const c = await post<ConductorReply>('/api/agents/conductor', { vibe, overrides, sessionId: s.id });
    if (session !== s) return;
    addTokens('conductor', c.tokens);
    s.state.tempo = c.bpm;
    s.state.key = c.key;
    s.state.timeSignature = c.timeSignature;
    const meter = meterOf(c.timeSignature);
    s.stepsPerBar = meter.stepsPerBar;
    s.strong = strongSteps(meter.accentSteps);
    s.beats = meter.numerator;
    s.stepsPerBeat = 16 / meter.denominator;
    s.active = s.target = { bpm: c.bpm, key: c.key, timeSignature: c.timeSignature, preset: c.preset };
    s.arrangement = sanitizeArrangement(c.arrangement, c.key);
    s.slots = slotsOf(s.arrangement);
    showSettings(s.active);
    logConductor(c, overrides);
    log('system', `Song plan: ${describeArrangement(s.arrangement)} bars, then it loops.`);

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
  // Quarter-note pulse for the graph (beat 1 gets the bigger pulse from the beat counter above).
  transport.scheduleRepeat((time) => {
    Tone.getDraw().schedule(() => {
      if (session === s) graphPanel.beat(0.35);
    }, time);
  }, '4n');
  transport.start('+0.1');
  setMode('playing');
  if (s.current) announceSection(s, s.current.n);
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

// ---------- Graph legend (an overlay, so it takes no permanent space) ----------

function setLegend(open: boolean) {
  legendPop.hidden = !open;
  legendBtn.setAttribute('aria-expanded', String(open));
}
legendBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setLegend(legendPop.hidden === true);
});
document.addEventListener('click', (e) => {
  if (!legendPop.hidden && !legendPop.contains(e.target as Node)) setLegend(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setLegend(false);
});

// ---------- Studio switches ----------

const studioEl = document.querySelector<HTMLElement>('#studio')!;
studioEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-studio]');
  if (!btn) return;
  const on = btn.getAttribute('aria-checked') !== 'true';
  btn.setAttribute('aria-checked', String(on));
  btn.textContent = on ? 'ON' : 'OFF';
  getRig().setStudio(btn.dataset.studio as StudioKey, on);
});

steerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void steer(steerText.value);
});
steerQuick.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-steer]');
  if (btn) void steer(btn.dataset.steer ?? '');
});
// Build the audio graph now and load every sampled instrument, so Start is instant. Until then the button stays disabled.
startBtn.disabled = true;
void getRig()
  .load()
  .then(() => {
    warm = true;
    if (!session) setMode('idle');
  });

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', stop);
for (const el of [vibeEl, bpmEl]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void start();
  });
}

// Test hook for the headless checks (dev server only).
if (import.meta.env.DEV) {
  (window as unknown as { __jam: unknown }).__jam = { graph: graphPanel, rig: getRig(), tokens: () => Object.fromEntries(tokens), plans: () => (session ? [...session.plans.entries()].map(([n, p]) => ({ n, pos: p.pos, section: p.slot.section, startBar: p.startBar, sectionStartBar: p.sectionStartBar, chords: p.slot.chords })) : []) };
}
