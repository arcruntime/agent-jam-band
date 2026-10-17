import express from 'express';
import { z } from 'zod';
import { meterOf } from '../shared/meter.js';
import type { ConductorSettings } from '../shared/types.js';
import { AgentError, bassAgent, conductorAgent, conductorSteerAgent, drumsAgent, keysAgent, melodyAgent, voxAgent } from './agents.js';
import { config } from './config.js';
import { closeNeo4j, initNeo4j, onNeo4jConnected } from './graph.js';
import { getClient } from './llm.js';
import { discardBlocks, ensureSchema, loadGraph, memoryCtxSchema, rememberRecording, rememberSession, rememberSteer, sessionIdSchema } from './memory.js';
import { BARS, bassBarSchema, blockPlanSchema, conductorRequestSchema, describeIssues, drumBarSchema, jamStateSchema, keysBarSchema, melodyBarSchema } from './schemas.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Lists models the provider exposes. Optional ?q=glm filters by substring (case-insensitive).
app.get('/api/models', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    const all: { id: string; owned_by?: string }[] = [];
    for await (const m of getClient().models.list()) {
      all.push({ id: m.id, owned_by: m.owned_by });
    }
    all.sort((a, b) => a.id.localeCompare(b.id));

    const configured = process.env.AIAND_MODEL?.trim() ?? null;
    res.json({
      configuredModel: configured,
      configuredModelAvailable: configured ? all.some((m) => m.id === configured) : false,
      total: all.length,
      models: q ? all.filter((m) => m.id.toLowerCase().includes(q)) : all,
    });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.error('GET /api/models failed:', e.message);
    res.status(e.status && e.status >= 400 ? 502 : 500).json({
      error: e.message ?? 'Unknown error',
      upstreamStatus: e.status ?? null,
    });
  }
});

function route(path: string, run: (body: Record<string, unknown>) => Promise<unknown>) {
  app.post(path, async (req, res) => {
    try {
      res.json(await run((req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      if (err instanceof z.ZodError) return void res.status(400).json({ error: describeIssues(err) });
      const e = err as { status?: number; message?: string };
      console.error(`${path} failed:`, e.message);
      res.status(err instanceof AgentError || e.status ? 502 : 500).json({ error: e.message ?? 'Unknown error' });
    }
  });
}

const four = <T extends z.ZodType>(schema: T) => z.array(schema).length(BARS);
const stepsFor = (state: z.infer<typeof jamStateSchema>) => meterOf(state.timeSignature).stepsPerBar;

// Conductor: runs first on each new vibe. Returns { bpm, key, timeSignature, why, latencyMs }.
route('/api/agents/conductor', async (b) => {
  const { vibe, overrides, sessionId, steer } = conductorRequestSchema.parse(b);
  if (steer) {
    // Live steering: the conductor answers with the settings to switch to. An empty why means nothing changed, so nothing is stored.
    const out = await conductorSteerAgent(vibe, steer.current as ConductorSettings, steer.text);
    if (sessionId && out.why) {
      rememberSteer(sessionId, { id: steer.id ?? String(Date.now()), text: steer.text, atBlock: steer.atBlock ?? 0, why: out.why }, { bpm: out.bpm, key: out.key, timeSignature: out.timeSignature, preset: out.preset });
    }
    return out;
  }
  const reply = await conductorAgent(vibe, overrides);
  if (sessionId) rememberSession(sessionId, { vibe, bpm: reply.bpm, key: reply.key, timeSignature: reply.timeSignature, preset: reply.preset });
  return reply;
});

// Blocks generated for the old direction that will never play after a live steer: drop them from the band's memory.
route('/api/memory/discard', async (b) => {
  const { sessionId, blocks } = z.object({ sessionId: sessionIdSchema, blocks: z.array(z.number().int().min(1).max(100000)).max(64) }).parse(b);
  discardBlocks(sessionId, blocks);
  return { ok: true };
});

// A finished recording: only a summary is kept (bars and length). The file itself never leaves the listener's computer.
route('/api/recording', async (b) => {
  const r = z
    .object({
      sessionId: sessionIdSchema,
      id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
      startBar: z.number().int().min(1).max(1_000_000),
      endBar: z.number().int().min(1).max(1_000_000),
      durationSec: z.number().min(0).max(86_400),
    })
    .refine((v) => v.endBar >= v.startBar, { message: 'endBar must not come before startBar' })
    .parse(b);
  rememberRecording(r.sessionId, { id: r.id, startBar: r.startBar, endBar: r.endBar, durationSec: Math.round(r.durationSec) });
  return { ok: true };
});

// Where this request belongs in the band's memory. A missing or malformed value just means no memory for this call.
const memoryOf = (b: Record<string, unknown>) => memoryCtxSchema.safeParse(b.memory).data;

// The song section and per-bar chords this block is written for. Missing or malformed means the agents just play without a plan.
const planOf = (b: Record<string, unknown>) => blockPlanSchema.safeParse(b.plan).data;

// Musicians, in order. Each gets the shared state plus every earlier part for the same 4 bars.
route('/api/agents/drums', async (b) => drumsAgent(jamStateSchema.parse(b.state), memoryOf(b), planOf(b)));

route('/api/agents/bass', async (b) => {
  const state = jamStateSchema.parse(b.state);
  return bassAgent(state, four(drumBarSchema(stepsFor(state))).parse(b.drums), memoryOf(b), planOf(b));
});

route('/api/agents/keys', async (b) => {
  const state = jamStateSchema.parse(b.state);
  const steps = stepsFor(state);
  return keysAgent(state, four(drumBarSchema(steps)).parse(b.drums), four(bassBarSchema(steps)).parse(b.bass), memoryOf(b), planOf(b));
});

route('/api/agents/melody', async (b) => {
  const state = jamStateSchema.parse(b.state);
  const steps = stepsFor(state);
  return melodyAgent(
    state,
    four(drumBarSchema(steps)).parse(b.drums),
    four(bassBarSchema(steps)).parse(b.bass),
    four(keysBarSchema(steps)).parse(b.keys),
    memoryOf(b),
    planOf(b),
  );
});

// The vox chops the melody: it reads the drums, the keys and the melody of the same 4 bars.
route('/api/agents/vox', async (b) => {
  const state = jamStateSchema.parse(b.state);
  const steps = stepsFor(state);
  return voxAgent(state, four(drumBarSchema(steps)).parse(b.drums), four(keysBarSchema(steps)).parse(b.keys), four(melodyBarSchema(steps)).parse(b.melody), memoryOf(b), planOf(b));
});

// The band's memory graph for one session, for the force-graph panel. Always 200: if Neo4j is off the lists are empty and available is false.
app.get('/api/graph', async (req, res) => {
  const id = sessionIdSchema.safeParse(req.query.session);
  if (!id.success) return void res.status(400).json({ error: 'session query parameter is required' });
  res.json(await loadGraph(id.data));
});

onNeo4jConnected(ensureSchema);

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  // The UI never shows errors, so a broken setup would otherwise only sound like a canned loop. Say so here.
  for (const name of ['AIAND_BASE_URL', 'AIAND_API_KEY', 'AIAND_MODEL']) {
    if (!process.env[name]?.trim()) console.error(`WARNING: ${name} is empty in .env, so every agent call will fail and the band will fall back to canned patterns.`);
  }
  void initNeo4j(); // logs "neo4j connected", or one console line if it cannot connect; the server runs either way
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void closeNeo4j().finally(() => process.exit(0)));
}
