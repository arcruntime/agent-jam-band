import express from 'express';
import { z } from 'zod';
import { meterOf } from '../shared/meter.js';
import { AgentError, bassAgent, conductorAgent, drumsAgent, keysAgent, melodyAgent } from './agents.js';
import { config } from './config.js';
import { getClient } from './llm.js';
import { BARS, bassBarSchema, conductorRequestSchema, describeIssues, drumBarSchema, jamStateSchema, keysBarSchema } from './schemas.js';

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
  const { vibe, overrides } = conductorRequestSchema.parse(b);
  return conductorAgent(vibe, overrides);
});

// Musicians, in order. Each gets the shared state plus every earlier part for the same 4 bars.
route('/api/agents/drums', async (b) => drumsAgent(jamStateSchema.parse(b.state)));

route('/api/agents/bass', async (b) => {
  const state = jamStateSchema.parse(b.state);
  return bassAgent(state, four(drumBarSchema(stepsFor(state))).parse(b.drums));
});

route('/api/agents/keys', async (b) => {
  const state = jamStateSchema.parse(b.state);
  const steps = stepsFor(state);
  return keysAgent(state, four(drumBarSchema(steps)).parse(b.drums), four(bassBarSchema(steps)).parse(b.bass));
});

route('/api/agents/melody', async (b) => {
  const state = jamStateSchema.parse(b.state);
  const steps = stepsFor(state);
  return melodyAgent(
    state,
    four(drumBarSchema(steps)).parse(b.drums),
    four(bassBarSchema(steps)).parse(b.bass),
    four(keysBarSchema(steps)).parse(b.keys),
  );
});

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  // The UI never shows errors, so a broken setup would otherwise only sound like a canned loop. Say so here.
  for (const name of ['AIAND_BASE_URL', 'AIAND_API_KEY', 'AIAND_MODEL']) {
    if (!process.env[name]?.trim()) console.error(`WARNING: ${name} is empty in .env, so every agent call will fail and the band will fall back to canned patterns.`);
  }
});
