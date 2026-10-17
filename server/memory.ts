import { z } from 'zod';
import type { BassBar, ChordBar, DrumBar, GraphLink, GraphNode, GraphPayload, MelodyBar } from '../shared/types.js';
import { query, toNum } from './graph.js';

/**
 * The band's memory: every agent's phrase is stored in Neo4j as a Motif, and later agents are shown a few recent motifs from the other players so they can call one back.
 * Everything here is best effort: when Neo4j is unavailable, recall gives an empty list, writes are dropped and the graph is empty. Nothing throws.
 */

export type MemoryAgent = 'drums' | 'bass' | 'keys' | 'melody';
export const MEMORY_AGENTS: readonly MemoryAgent[] = ['drums', 'bass', 'keys', 'melody'];

const idPart = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const sessionIdSchema = idPart;
export const memoryCtxSchema = z.object({ sessionId: idPart, block: z.number().int().min(1).max(100000) });
export type MemoryCtx = z.infer<typeof memoryCtxSchema>;

export interface Echo {
  id: string;
  reason: string;
}

export interface BandMemoryItem {
  id: string;
  agent: string;
  block: number;
  summary: string;
}

/** Each part answers the one it is built on: bass locks to the kick, keys sit on the bass, the melody sits on the chords. */
const LOCKS: Partial<Record<MemoryAgent, MemoryAgent>> = { bass: 'drums', keys: 'bass', melody: 'keys' };

export const motifId = (sessionId: string, block: number, agent: string) => `${sessionId}:${block}:${agent}`;

const RECALL_TIMEOUT_MS = 1500;
const FLUSH_TIMEOUT_MS = 2000;
const MAX_SUMMARY = 240;

// ---------- Describing a phrase (this text is what other agents read as band memory) ----------

const stepsOf = (row: number[]) => row.flatMap((v, i) => (v ? [i] : []));

export function describeDrums(bars: DrumBar[]): string {
  const b = bars[0];
  if (!b) return '';
  return `bar 1: kick@${stepsOf(b.kick).join(',') || '-'} snare@${stepsOf(b.snare).join(',') || '-'} hats x${stepsOf(b.hat).length}`;
}

export function describeBass(bars: BassBar[]): string {
  const notes = (bars.find((b) => b.length) ?? []).slice(0, 6);
  return `bar 1: ${notes.map((n) => `${n.note}@${n.step}`).join(' ')}`;
}

export function describeKeys(bars: ChordBar[]): string {
  const chords = (bars.find((b) => b.length) ?? []).slice(0, 3);
  return `bar 1: ${chords.map((c) => `[${c.notes.join(' ')}]@${c.step}`).join(' ')}`;
}

export function describeMelody(bars: MelodyBar[]): string {
  const i = bars.findIndex((b) => b.length);
  if (i < 0) return 'rests';
  return `bar ${i + 1}: ${bars[i].slice(0, 8).map((n) => `${n.note}@${n.step}`).join(' ')}`;
}

export function summarize(agent: MemoryAgent, bars: unknown[], why: string, fallback: boolean): string {
  const b = bars as never[];
  const detail = agent === 'drums' ? describeDrums(b) : agent === 'bass' ? describeBass(b) : agent === 'keys' ? describeKeys(b) : describeMelody(b);
  const lead = fallback || !why ? '(repeated an earlier phrase)' : why;
  return `${lead} | ${detail}`.slice(0, MAX_SUMMARY);
}

// ---------- Writes (serialised, so an edge never points at a motif that is not written yet) ----------

let tail: Promise<unknown> = Promise.resolve();

function enqueue(label: string, job: () => Promise<unknown>) {
  tail = tail.then(job).catch((err) => console.error(`[memory] ${label} failed: ${(err as Error).message}`));
}

/** Waits (briefly) for queued writes, so a read right after a write sees it. */
async function flush() {
  await Promise.race([tail, new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
}

export function rememberSession(sessionId: string, info: { vibe: string; bpm: number; key: string; timeSignature: string; preset: string }) {
  enqueue('session', () =>
    query(
      'write',
      `MERGE (s:Session {id: $sid})
       SET s.vibe = $vibe, s.bpm = toInteger($bpm), s.key = $key, s.timeSignature = $ts, s.preset = $preset, s.startedAt = coalesce(s.startedAt, datetime())`,
      { sid: sessionId, vibe: info.vibe, bpm: info.bpm, key: info.key, ts: info.timeSignature, preset: info.preset },
    ),
  );
}

/** Stores one agent's phrase as a Motif in its block, linked to the agent, to the part it locks to and to the motif it calls back (if any). */
export function remember(ctx: MemoryCtx, agent: MemoryAgent, motif: { bars: unknown[]; why: string; echoes: Echo | null; fallback: boolean }) {
  const lockAgent = LOCKS[agent];
  const params = {
    sid: ctx.sessionId,
    block: ctx.block,
    id: motifId(ctx.sessionId, ctx.block, agent),
    agent,
    pattern: JSON.stringify(motif.bars),
    summary: summarize(agent, motif.bars, motif.why, motif.fallback),
    fallback: motif.fallback,
    lockId: lockAgent ? motifId(ctx.sessionId, ctx.block, lockAgent) : null,
    echoId: motif.echoes?.id ?? null,
    reason: motif.echoes?.reason ?? null,
  };
  enqueue(`${agent} motif`, () =>
    query(
      'write',
      `MERGE (s:Session {id: $sid})
       MERGE (b:Block {index: toInteger($block)})-[:IN_SESSION]->(s)
         ON CREATE SET b.bars = 4
       MERGE (m:Motif {id: $id})
         SET m.agent = $agent, m.pattern_json = $pattern, m.summary = $summary, m.fallback = $fallback, m.createdAt = timestamp()
       MERGE (m)-[:IN_BLOCK]->(b)
       MERGE (a:Agent {name: $agent})
       MERGE (a)-[:PLAYED]->(m)
       WITH s, m
       OPTIONAL MATCH (lock:Motif {id: $lockId})
       FOREACH (x IN CASE WHEN lock IS NULL THEN [] ELSE [1] END | MERGE (m)-[:LOCKS_TO]->(lock))
       WITH s, m
       OPTIONAL MATCH (target:Motif {id: $echoId})-[:IN_BLOCK]->(:Block)-[:IN_SESSION]->(s)
       FOREACH (y IN CASE WHEN target IS NULL OR target = m THEN [] ELSE [1] END | MERGE (m)-[r:ECHOES]->(target) SET r.reason = $reason)`,
      params,
    ),
  );
}

/** Runs once per (re)connection: uniqueness constraints, which also create the lookup indexes. */
export function ensureSchema() {
  enqueue('schema', async () => {
    for (const q of [
      'CREATE CONSTRAINT session_id IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS UNIQUE',
      'CREATE CONSTRAINT motif_id IF NOT EXISTS FOR (m:Motif) REQUIRE m.id IS UNIQUE',
      'CREATE CONSTRAINT agent_name IF NOT EXISTS FOR (a:Agent) REQUIRE a.name IS UNIQUE',
    ]) {
      await query('write', q);
    }
  });
}

// ---------- Reads ----------

/** The top 3 most recent motifs from the OTHER agents in this session, from earlier blocks. Empty when Neo4j is unavailable or slow. */
export async function recall(ctx: MemoryCtx, agent: MemoryAgent): Promise<BandMemoryItem[]> {
  const read = async () => {
    await flush();
    const rows = await query(
      'read',
      `MATCH (m:Motif)-[:IN_BLOCK]->(b:Block)-[:IN_SESSION]->(:Session {id: $sid})
       WHERE m.agent <> $agent AND b.index < toInteger($block) AND coalesce(m.fallback, false) = false
       RETURN m.id AS id, m.agent AS agent, b.index AS block, m.summary AS summary
       ORDER BY m.createdAt DESC LIMIT 3`,
      { sid: ctx.sessionId, agent, block: ctx.block },
    );
    return (rows ?? []).map((r) => ({ id: String(r.get('id')), agent: String(r.get('agent')), block: toNum(r.get('block')), summary: String(r.get('summary') ?? '') }));
  };
  try {
    return await Promise.race([read(), new Promise<BandMemoryItem[]>((resolve) => setTimeout(() => resolve([]), RECALL_TIMEOUT_MS))]);
  } catch (err) {
    console.error(`[memory] recall failed: ${(err as Error).message}`);
    return [];
  }
}

/** Everything the force-graph panel needs for one session. */
export async function loadGraph(sessionId: string): Promise<GraphPayload> {
  const empty: GraphPayload = { nodes: [], links: [], available: false };
  try {
    await flush();
    const p = { sid: sessionId };
    const [sessionRows, blockRows, motifRows, playedRows, relRows] = await Promise.all([
      query('read', 'MATCH (s:Session {id: $sid}) RETURN s.vibe AS vibe', p),
      query('read', 'MATCH (b:Block)-[:IN_SESSION]->(:Session {id: $sid}) RETURN b.index AS index ORDER BY b.index', p),
      query(
        'read',
        `MATCH (m:Motif)-[:IN_BLOCK]->(b:Block)-[:IN_SESSION]->(:Session {id: $sid})
         RETURN m.id AS id, m.agent AS agent, m.summary AS summary, b.index AS block ORDER BY b.index, m.createdAt`,
        p,
      ),
      query('read', 'MATCH (a:Agent)-[:PLAYED]->(m:Motif)-[:IN_BLOCK]->(:Block)-[:IN_SESSION]->(:Session {id: $sid}) RETURN a.name AS agent, m.id AS motif', p),
      query(
        'read',
        `MATCH (m:Motif)-[:IN_BLOCK]->(:Block)-[:IN_SESSION]->(:Session {id: $sid})
         MATCH (m)-[r:ECHOES|LOCKS_TO]->(t:Motif)-[:IN_BLOCK]->(:Block)-[:IN_SESSION]->(:Session {id: $sid})
         RETURN m.id AS source, t.id AS target, type(r) AS type, r.reason AS reason`,
        p,
      ),
    ]);
    if (!sessionRows || !blockRows || !motifRows || !playedRows || !relRows) return empty;

    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const sessionNode = `session:${sessionId}`;
    if (sessionRows.length) nodes.push({ id: sessionNode, type: 'session', label: 'session' });

    for (const r of blockRows) {
      const index = toNum(r.get('index'));
      nodes.push({ id: `block:${index}`, type: 'block', label: `block ${index}`, block: index });
      if (sessionRows.length) links.push({ source: `block:${index}`, target: sessionNode, type: 'IN_SESSION' });
    }
    const agents = new Set<string>();
    for (const r of motifRows) {
      const agent = String(r.get('agent'));
      const block = toNum(r.get('block'));
      agents.add(agent);
      nodes.push({ id: String(r.get('id')), type: 'motif', label: `${agent} ${block}`, agent, block, summary: String(r.get('summary') ?? '') });
      links.push({ source: String(r.get('id')), target: `block:${block}`, type: 'IN_BLOCK' });
    }
    for (const agent of MEMORY_AGENTS) if (agents.has(agent)) nodes.push({ id: `agent:${agent}`, type: 'agent', label: agent, agent });
    for (const r of playedRows) links.push({ source: `agent:${String(r.get('agent'))}`, target: String(r.get('motif')), type: 'PLAYED' });
    for (const r of relRows) {
      const reason = r.get('reason');
      links.push({ source: String(r.get('source')), target: String(r.get('target')), type: r.get('type') as GraphLink['type'], ...(reason ? { reason: String(reason) } : {}) });
    }
    return { nodes, links, available: true };
  } catch (err) {
    console.error(`[memory] loading the graph failed: ${(err as Error).message}`);
    return empty;
  }
}
