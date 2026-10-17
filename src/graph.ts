import ForceGraph from 'force-graph';
import type { GraphLink, GraphNode, GraphPayload } from '../shared/types';

/**
 * The band-memory panel: a live force-directed graph of the session's motifs. Nodes are coloured by agent, ECHOES links are drawn bright with moving particles, and a node pulses when a new echo appears.
 * Feed it the payload from GET /api/graph; it keeps node positions between refreshes so the layout stays calm.
 */

type GNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number };
type GLink = Omit<GraphLink, 'source' | 'target'> & { source: string | GNode; target: string | GNode };

export interface EchoEvent {
  /** The motif that called another one back */
  from: GraphNode;
  /** The earlier motif it brought back */
  to: GraphNode;
  reason?: string;
}

const PULSE_MS = 1600;
/** How long one beat's swell takes to fade, how long an instrument's flash lasts, and how long a brand-new ECHOES edge stays highlighted. */
const BEAT_MS = 280;
const FLASH_MS = 240;
const ECHO_HILITE_MS = 2000;
const STRUCTURE = 'rgba(139, 143, 163, 0.16)';
const ECHO = '#ffffff';
const STEER = '#ff5fa2';
const SECTION = '#cdd3ff';

const idOf = (end: string | GNode) => (typeof end === 'string' ? end : end.id);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createGraphPanel(host: HTMLElement, colors: Record<string, string>) {
  const nodes = new Map<string, GNode>();
  const seenEchoes = new Set<string>();
  const seenSteers = new Set<string>();
  // Music reactions. They only change how nodes are drawn (no data or layout changes), and the canvas already repaints every animation frame.
  let beatPulse = { start: -1e9, strength: 0 };
  const flashes = new Map<string, number>();
  const echoSince = new Map<string, number>();
  const beatEnv = () => {
    const t = (performance.now() - beatPulse.start) / BEAT_MS;
    return t >= 1 ? 0 : beatPulse.strength * (1 - t) * (1 - t);
  };
  const freshEcho = (l: GLink) => {
    const since = echoSince.get(`${idOf(l.source)}>${idOf(l.target)}`);
    return since !== undefined && performance.now() - since < ECHO_HILITE_MS;
  };
  const pulses = new Map<string, { start: number; strength: number }>();
  let involved = new Set<string>();
  let signature = '';

  const colorOf = (n: GNode) => (n.agent && colors[n.agent]) || '#8b8fa3';

  const graph = new ForceGraph<GNode, GLink>(host)
    .backgroundColor('rgba(0,0,0,0)')
    .autoPauseRedraw(false) // pulses animate after the layout has settled
    .cooldownTime(5000)
    .nodeId('id')
    .nodeLabel((n) => {
      const node = n as GNode;
      if (node.type === 'steer') return `<b>Steer${node.block ? ` · block ${node.block}` : ''}</b><br>${escapeHtml(node.summary ?? node.label)}`;
      if (node.type === 'section') return `<b>${escapeHtml(node.label)}</b><br>${escapeHtml(node.summary ?? '')}`;
      if (node.type === 'motif') return `<b>${escapeHtml(node.agent ?? '')} · block ${node.block ?? ''}</b><br>${escapeHtml(node.summary ?? '')}`;
      return escapeHtml(node.label);
    })
    .linkColor((l) => {
      const link = l as GLink;
      if (link.type === 'ECHOES') return freshEcho(link) ? ECHO : 'rgba(255,255,255,0.5)';
      if (link.type === 'CHANGED') return STEER + 'cc';
      if (link.type === 'LOCKS_TO') return (nodes.get(idOf(link.source)) && colorOf(nodes.get(idOf(link.source))!)) + '99';
      return STRUCTURE;
    })
    .linkWidth((l) => {
      const link = l as GLink;
      if (link.type === 'ECHOES') return freshEcho(link) ? 6 : 1.8; // a new echo is thick and bright for two seconds, then settles
      return link.type === 'LOCKS_TO' || link.type === 'CHANGED' ? 1.3 : 0.6;
    })
    .linkLineDash((l) => ((l as GLink).type === 'LOCKS_TO' || (l as GLink).type === 'CHANGED' ? [4, 3] : null))
    .linkDirectionalParticles((l) => ((l as GLink).type === 'ECHOES' ? (freshEcho(l as GLink) ? 5 : 1) : 0))
    .linkDirectionalParticleWidth(2.6)
    .linkDirectionalParticleSpeed(0.012)
    .linkDirectionalParticleColor(() => ECHO)
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject((n, ctx, scale) => paint(n as GNode, ctx, scale))
    .nodePointerAreaPaint((n, color, ctx) => {
      const node = n as GNode;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radius(node) + 3, 0, Math.PI * 2);
      ctx.fill();
    });

  graph.d3Force('charge')?.strength(-42);
  graph
    .d3Force('link')
    ?.distance((l: GLink) => ({ ECHOES: 90, PLAYED: 62, IN_BLOCK: 22, IN_SESSION: 34, IN_SECTION: 30, LOCKS_TO: 24, CHANGED: 70 })[l.type] ?? 40)
    .strength?.(0.5);

  function radius(n: GNode) {
    return n.type === 'agent' ? 9 : n.type === 'steer' ? 8 : n.type === 'section' ? 7 : n.type === 'motif' ? 6 : n.type === 'session' ? 4 : 3;
  }

  function paint(n: GNode, ctx: CanvasRenderingContext2D, scale: number) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = radius(n) * (1 + 0.3 * beatEnv()); // every node swells a little on each beat, more on beat 1
    const flashAt = n.type === 'agent' && n.agent ? flashes.get(n.agent) : undefined;
    if (flashAt !== undefined) {
      const t = (performance.now() - flashAt) / FLASH_MS;
      if (t >= 1) flashes.delete(n.agent!);
      else {
        // The instrument just played: a halo in its own colour.
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + 14 * t, 0, Math.PI * 2);
        ctx.fillStyle = colorOf(n);
        ctx.globalAlpha = 0.75 * (1 - t);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    const pulse = pulses.get(n.id);
    if (pulse) {
      const t = (performance.now() - pulse.start) / PULSE_MS;
      if (t >= 1) pulses.delete(n.id);
      else {
        ctx.beginPath();
        ctx.arc(x, y, r + t * 26, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * pulse.strength})`;
        ctx.lineWidth = 2.5 * (1 - t) + 0.5;
        ctx.stroke();
      }
    }
    if (n.type === 'section') {
      // A rounded square, so a song section never reads as a block, a motif or an agent.
      const half = r + 1;
      ctx.beginPath();
      ctx.roundRect(x - half, y - half, half * 2, half * 2, 3);
      ctx.fillStyle = SECTION;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(14,15,19,0.9)';
      ctx.stroke();
      ctx.font = `${10 / scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = SECTION;
      ctx.fillText(n.label, x, y + half + 11 / scale);
      return;
    }
    if (n.type === 'steer') {
      // A diamond in its own colour, so a steer never reads as a motif.
      ctx.beginPath();
      ctx.moveTo(x, y - r - 2);
      ctx.lineTo(x + r + 2, y);
      ctx.lineTo(x, y + r + 2);
      ctx.lineTo(x - r - 2, y);
      ctx.closePath();
      ctx.fillStyle = STEER;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(14,15,19,0.9)';
      ctx.stroke();
      ctx.font = `${10 / scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = STEER;
      ctx.fillText(n.label, x, y + r + 12 / scale);
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (n.type === 'block' || n.type === 'session') {
      ctx.fillStyle = n.type === 'block' ? '#3a3f52' : '#8b8fa3';
      ctx.fill();
      return;
    }
    ctx.fillStyle = colorOf(n);
    ctx.globalAlpha = n.type === 'agent' ? 1 : 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (n.type === 'agent') {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(14,15,19,0.9)';
      ctx.stroke();
      ctx.font = `${11 / scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8e9ee';
      ctx.fillText(n.label, x, y + r + 9 / scale);
    } else if (involved.has(n.id)) {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = ECHO;
      ctx.stroke();
    }
  }

  // Added after the graph is created: force-graph empties its container when it starts.
  const empty = document.createElement('p');
  empty.className = 'graph-empty';
  empty.textContent = "The band's memory fills in as the players trade phrases.";
  host.append(empty);

  const resize = () => graph.width(host.clientWidth).height(host.clientHeight);
  resize();
  new ResizeObserver(resize).observe(host);

  function pulse(id: string, strength: number) {
    pulses.set(id, { start: performance.now(), strength });
  }

  return {
    /** Merges a fresh payload into the graph. Returns the ECHOES links that were not there on the previous update. */
    update(payload: GraphPayload): EchoEvent[] {
      const liveIds = new Set(payload.nodes.map((n) => n.id));
      for (const id of [...nodes.keys()]) if (!liveIds.has(id)) nodes.delete(id);
      for (const incoming of payload.nodes) {
        const known = nodes.get(incoming.id);
        if (known) Object.assign(known, incoming);
        else {
          // New nodes start near their agent hub (or the middle) so they ease into place.
          const hub = incoming.agent ? nodes.get(`agent:${incoming.agent}`) : undefined;
          nodes.set(incoming.id, { ...incoming, x: (hub?.x ?? 0) + (Math.random() - 0.5) * 20, y: (hub?.y ?? 0) + (Math.random() - 0.5) * 20 });
        }
      }

      const links: GLink[] = payload.links.filter((l) => nodes.has(l.source) && nodes.has(l.target)).map((l) => ({ ...l }));
      involved = new Set(links.filter((l) => l.type === 'ECHOES').flatMap((l) => [idOf(l.source), idOf(l.target)]));

      const events: EchoEvent[] = [];
      for (const l of links) {
        if (l.type !== 'ECHOES') continue;
        const key = `${idOf(l.source)}>${idOf(l.target)}`;
        if (seenEchoes.has(key)) continue;
        seenEchoes.add(key);
        const from = nodes.get(idOf(l.source))!;
        const to = nodes.get(idOf(l.target))!;
        pulse(from.id, 1);
        pulse(to.id, 0.55);
        echoSince.set(key, performance.now());
        events.push({ from, to, reason: l.reason });
      }

      for (const n of nodes.values()) {
        if (n.type !== 'steer' || seenSteers.has(n.id)) continue;
        seenSteers.add(n.id);
        pulse(n.id, 1);
      }

      const next = `${nodes.size}/${links.length}`;
      if (next !== signature) {
        signature = next;
        graph.graphData({ nodes: [...nodes.values()], links });
      }
      empty.hidden = nodes.size > 0;
      return events;
    },

    /** One beat of the music: every node swells for a moment (strength 1 = beat 1, about 0.35 = the other beats). */
    beat(strength: number) {
      const now = performance.now();
      const left = beatEnv();
      // A new beat never cuts a bigger swell short.
      if (strength >= left) beatPulse = { start: now, strength };
    },

    /** An instrument just sounded: its hub node flashes in its own colour. */
    flash(agent: string) {
      flashes.set(agent, performance.now());
    },

    /** For tests: what is currently animating. */
    debug() {
      const now = performance.now();
      return {
        beatEnv: beatEnv(),
        flashing: [...flashes.keys()],
        freshEchoes: [...echoSince.entries()].filter(([, t]) => now - t < ECHO_HILITE_MS).map(([k]) => k),
      };
    },

    clear() {
      flashes.clear();
      echoSince.clear();
      beatPulse = { start: -1e9, strength: 0 };
      nodes.clear();
      seenEchoes.clear();
      seenSteers.clear();
      pulses.clear();
      involved = new Set();
      signature = '';
      graph.graphData({ nodes: [], links: [] });
      empty.hidden = false;
    },
  };
}
