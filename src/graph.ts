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
const STRUCTURE = 'rgba(139, 143, 163, 0.16)';
const ECHO = '#ffffff';

const idOf = (end: string | GNode) => (typeof end === 'string' ? end : end.id);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createGraphPanel(host: HTMLElement, colors: Record<string, string>) {
  const nodes = new Map<string, GNode>();
  const seenEchoes = new Set<string>();
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
      if (node.type === 'motif') return `<b>${escapeHtml(node.agent ?? '')} · block ${node.block ?? ''}</b><br>${escapeHtml(node.summary ?? '')}`;
      return escapeHtml(node.label);
    })
    .linkColor((l) => {
      const link = l as GLink;
      if (link.type === 'ECHOES') return ECHO;
      if (link.type === 'LOCKS_TO') return (nodes.get(idOf(link.source)) && colorOf(nodes.get(idOf(link.source))!)) + '99';
      return STRUCTURE;
    })
    .linkWidth((l) => ((l as GLink).type === 'ECHOES' ? 2.6 : (l as GLink).type === 'LOCKS_TO' ? 1.3 : 0.6))
    .linkLineDash((l) => ((l as GLink).type === 'LOCKS_TO' ? [4, 3] : null))
    .linkDirectionalParticles((l) => ((l as GLink).type === 'ECHOES' ? 3 : 0))
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
    ?.distance((l: GLink) => ({ ECHOES: 90, PLAYED: 62, IN_BLOCK: 22, IN_SESSION: 34, LOCKS_TO: 24 })[l.type] ?? 40)
    .strength?.(0.5);

  function radius(n: GNode) {
    return n.type === 'agent' ? 9 : n.type === 'motif' ? 6 : n.type === 'session' ? 4 : 3;
  }

  function paint(n: GNode, ctx: CanvasRenderingContext2D, scale: number) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = radius(n);
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
        events.push({ from, to, reason: l.reason });
      }

      const next = `${nodes.size}/${links.length}`;
      if (next !== signature) {
        signature = next;
        graph.graphData({ nodes: [...nodes.values()], links });
      }
      empty.hidden = nodes.size > 0;
      return events;
    },

    clear() {
      nodes.clear();
      seenEchoes.clear();
      pulses.clear();
      involved = new Set();
      signature = '';
      graph.graphData({ nodes: [], links: [] });
      empty.hidden = false;
    },
  };
}
