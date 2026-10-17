import express from 'express';
import { config } from './config.js';
import { getClient } from './llm.js';
import { AgentError, bassAgent, drumsAgent } from './agents.js';
import { bassRequestSchema, drumsRequestSchema } from './schemas.js';

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

function sendError(res: express.Response, err: unknown) {
  const e = err as { status?: number; message?: string };
  console.error('agent request failed:', e.message);
  res.status(err instanceof AgentError || e.status ? 502 : 500).json({ error: e.message ?? 'Unknown error' });
}

// Drummer: reads the shared state, returns { why, bars: [4 x { kick, snare, hat }] }.
app.post('/api/agents/drums', async (req, res) => {
  const body = drumsRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.message });
  try {
    res.json(await drumsAgent(body.data.state));
  } catch (err) {
    sendError(res, err);
  }
});

// Bassist: gets the shared state plus the drummer's new 4 bars, returns { why, bars: [4 x notes[]] }.
app.post('/api/agents/bass', async (req, res) => {
  const body = bassRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.message });
  try {
    res.json(await bassAgent(body.data.state, body.data.drums));
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
