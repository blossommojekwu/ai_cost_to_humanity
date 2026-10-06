import express, { Request, Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AIIncident,
  IncidentWithScore,
  SearchRequest,
  SearchResponse,
  EnvironmentalCost,
  ModelOption,
  SizeBucket,
} from './types/index.js';
import {
  SIZE_ASSUMPTIONS,
  bucketFromTokens,
  bucketFromWords,
  countWords,
  findDefaultGeminiRow,
  findRow,
  getModelRows,
  loadEnvironmentalData,
} from './environmental.js';
import { Store } from './db.js';
import { currentLogin, registerAccountRoutes } from './auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Works from both ./server.ts (tsx) and ./dist/server.js (compiled)
const ROOT = fs.existsSync(path.join(__dirname, 'data')) ? __dirname : path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'ai_incidents.json');
const EMBEDDINGS_PATH = path.join(ROOT, 'data', 'embeddings.json');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error('GEMINI_API_KEY environment variable is not set');
}
const genAI = new GoogleGenerativeAI(apiKey);
const EMBEDDING_MODEL = 'gemini-embedding-001';
// Model used for countTokens (the "current Gemini model" default). Override via GEMINI_MODEL.
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';
const ENV_CSV_PATH = path.join(ROOT, 'data', 'ai_environmental_cost.csv');
const DEFAULT_MODEL_ID = '__default_gemini__';
// CSV row used for the default Gemini model's figures. Override via DEFAULT_ENV_MODEL.
const defaultGeminiRow = () => findDefaultGeminiRow(process.env.DEFAULT_ENV_MODEL);

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// ---- small in-memory helpers: cache + rate limit -------------------------------------
/** Tiny LRU (Map keeps insertion order). */
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: V): void {
    this.m.delete(k); this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  delete(k: string): void { this.m.delete(k); }
}
// Repeated prompts (same text) cost no Gemini call. Stores the promise so concurrent
// identical requests share one call; failures are evicted so they can be retried.
const queryVecCache = new Lru<Promise<Float32Array>>(500);
const tokenCache = new Lru<Promise<{ tokens: number; estimated: boolean }>>(500);
const normKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const MAX_QUERY_CHARS = Number(process.env.MAX_QUERY_CHARS ?? 1000);

// Per-IP fixed-window limiter for the routes that spend Gemini quota.
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 30);
const hits = new Map<string, { n: number; reset: number }>();
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60_000).unref();
function rateLimit(req: Request, res: Response, next: () => void) {
  const key = req.ip ?? 'unknown', now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + 60_000 }; hits.set(key, h); }
  if (++h.n > RATE_LIMIT) {
    res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
    return void res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
}

// Accounts, sessions, prompt history. Override the file with DB_PATH.
const store = new Store(process.env.DB_PATH ?? path.join(ROOT, 'data', 'app.db'));
registerAccountRoutes(app, store);
// An incident is irreversible when its Irreversibility score is at least this.
const IRREVERSIBLE_MIN = Number(process.env.IRREVERSIBLE_MIN ?? 4.0);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type Incident = AIIncident & Record<string, any>;

let incidents: Incident[] = [];
const incidentIds: string[] = [];
// Incident ID -> incident, so any field is one lookup away (no scanning)
const incidentById = new Map<string, Incident>();
// id -> L2-normalised embedding (so cosine similarity == dot product)
const embeddings = new Map<string, Float32Array>();
// Flat row-major copy of the vectors for scoring (one contiguous buffer, no Map lookups per request).
let matrix: Float32Array | null = null;
let matrixRows: number[] = [];   // incident index for each matrix row
let matrixDim = 0;
let matrixSize = -1;             // embeddings.size when the matrix was built
function ensureMatrix(): void {
  if (matrix && matrixSize === embeddings.size) return;
  const rows: number[] = [];
  for (let k = 0; k < incidents.length; k++) if (embeddings.has(incidentIds[k])) rows.push(k);
  matrixDim = rows.length ? embeddings.get(incidentIds[rows[0]])!.length : 0;
  const m = new Float32Array(rows.length * matrixDim);
  rows.forEach((k, r) => m.set(embeddings.get(incidentIds[k])!, r * matrixDim));
  matrix = m; matrixRows = rows; matrixSize = embeddings.size;
}
let building = false;
let lastBuildError: string | null = null;

// Similarity above which a result is returned. Embedding cosine scores for
// related text with gemini-embedding-001 typically fall in the 0.5-0.8 range,
// so this is deliberately lower than a "percentage match" intuition suggests.
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY ?? 0.60);
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 1671); // 1671 = all incidents in the dataset

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getId(i: Incident): string {
  return String(i['Incident ID'] ?? i.id);
}

/** Text that represents an incident for embedding: content + Tags + Risk Subdomain. */
function incidentText(i: Incident): string {
  const parts = [
    i.title,
    i.description,
    i.Tags ? `Tags: ${i.Tags}` : '',
    i.Techniques ? `Techniques: ${i.Techniques}` : '',
    i['Risk Domain'] ? `Risk domain: ${i['Risk Domain']}` : '',
    i['Risk Subdomain'] ? `Risk subdomain: ${i['Risk Subdomain']}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function normalise(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  let sum = 0;
  for (let k = 0; k < v.length; k++) sum += v[k] * v[k];
  const norm = Math.sqrt(sum) || 1;
  for (let k = 0; k < v.length; k++) v[k] /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
}

function retryDelayMs(err: any): number | null {
  const info = (err?.errorDetails ?? []).find((d: any) => String(d['@type']).includes('RetryInfo'));
  const m = info?.retryDelay?.match?.(/^(\d+(?:\.\d+)?)s$/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : null;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let backoff = 2000;
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err: any) {
      if (n >= attempts || ![429, 500, 503].includes(err?.status)) throw err;
      const wait = retryDelayMs(err) ?? backoff;
      console.warn(`Gemini ${err.status}; retrying in ${wait}ms (attempt ${n}/${attempts})`);
      await sleep(wait);
      backoff *= 2;
    }
  }
}

// ---------------------------------------------------------------------------
// Gemini embedding calls
// ---------------------------------------------------------------------------
async function embedQuery(text: string): Promise<Float32Array> {
  const key = normKey(text);
  const hit = queryVecCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const res = await withRetry(() =>
      model.embedContent({
        content: { role: 'user', parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_QUERY,
      })
    );
    return normalise(res.embedding.values);
  })();
  queryVecCache.set(key, p);
  p.catch(() => queryVecCache.delete(key));
  return p;
}

async function embedDocuments(texts: string[]): Promise<Float32Array[]> {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const res = await withRetry(() =>
    model.batchEmbedContents({
      requests: texts.map((text) => ({
        content: { role: 'user', parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_DOCUMENT,
      })),
    })
  );
  return res.embeddings.map((e) => normalise(e.values));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadEmbeddings(): void {
  if (!fs.existsSync(EMBEDDINGS_PATH)) return;
  try {
    const raw: Record<string, number[]> = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
    for (const [id, vec] of Object.entries(raw)) embeddings.set(id, normalise(vec));
    console.log(`Loaded ${embeddings.size} cached embeddings`);
  } catch (err) {
    console.error('Failed to read embeddings cache:', err);
  }
}

function saveEmbeddings(): void {
  const out: Record<string, number[]> = {};
  for (const [id, vec] of embeddings) out[id] = Array.from(vec, (x) => Math.round(x * 1e6) / 1e6);
  fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(out));
}

function loadDataset(): void {
  incidents = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  incidentIds.length = 0;
  incidentById.clear();
  for (const i of incidents) {
    incidentIds.push(getId(i));
    incidentById.set(getId(i), i);
  }
  console.log(`Loaded ${incidents.length} AI incidents`);
}

// ---------------------------------------------------------------------------
// Embedding index build (batched, resumable)
// ---------------------------------------------------------------------------
const BATCH_SIZE = 100;

async function buildEmbeddings(): Promise<void> {
  if (building) return;
  building = true;
  lastBuildError = null;
  try {
    const pending = incidents.filter((i) => !embeddings.has(getId(i)));
    console.log(`Embedding ${pending.length} incidents in batches of ${BATCH_SIZE}...`);
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);
      const vectors = await embedDocuments(batch.map(incidentText));
      batch.forEach((inc, k) => embeddings.set(getId(inc), vectors[k]));
      saveEmbeddings();
      console.log(`  embedded ${embeddings.size}/${incidents.length}`);
      await sleep(1000);
    }
    console.log('Embedding index complete');
  } catch (err: any) {
    lastBuildError = err?.message ?? String(err);
    console.error('Embedding build stopped:', lastBuildError);
  } finally {
    building = false;
  }
}

// ---------------------------------------------------------------------------
// Environmental cost
// ---------------------------------------------------------------------------
async function geminiTokenCount(text: string): Promise<{ tokens: number; estimated: boolean }> {
  const key = normKey(text);
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const p = geminiTokenCountUncached(text);
  tokenCache.set(key, p);
  // do not keep estimates: retry the real count next time
  p.then((r) => { if (r.estimated) tokenCache.delete(key); });
  return p;
}
async function geminiTokenCountUncached(text: string): Promise<{ tokens: number; estimated: boolean }> {
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const r = await model.countTokens(text);
    return { tokens: r.totalTokens, estimated: false };
  } catch (err: any) {
    // Never fail the whole search because token counting failed.
    console.warn('countTokens failed; estimating from word count:', err?.message);
    return { tokens: Math.ceil(countWords(text) * 1.5), estimated: true };
  }
}

/**
 * Default model (Gemini): size bucket comes from countTokens.
 * Every other model: size bucket comes from the prompt's word count.
 */
async function computeEnvironmental(query: string, modelId: string): Promise<EnvironmentalCost> {
  const isDefault = modelId === DEFAULT_MODEL_ID;
  const row = isDefault ? defaultGeminiRow() : findRow(modelId);

  let size: SizeBucket;
  let basis: 'tokens' | 'words';
  let measured: number;
  let measuredIsEstimate = false;
  if (isDefault) {
    const t = await geminiTokenCount(query);
    size = bucketFromTokens(t.tokens);
    basis = 'tokens';
    measured = t.tokens;
    measuredIsEstimate = t.estimated;
  } else {
    measured = countWords(query);
    size = bucketFromWords(measured);
    basis = 'words';
  }

  const label = row ? row.label : `Gemini (${GEMINI_MODEL})`;
  const cell = row?.bySize[size];
  const energyWh = cell?.energyWh ?? null;
  const energySdWh = cell?.energySdWh ?? null;
  const waterMl = cell?.waterMl ?? null;
  const carbonGCO2e = cell?.carbonGCO2e ?? null;

  let note: string | undefined;
  if (!row) {
    note =
      'The environmental dataset has no Gemini figures yet, so only the prompt size is shown. ' +
      'Select another model to compare.';
  } else {
    const missing = [
      energyWh === null ? 'energy' : '',
      waterMl === null ? 'water' : '',
      carbonGCO2e === null ? 'carbon' : '',
    ].filter(Boolean);
    if (missing.length) {
      note = `No ${size.toLowerCase()}-prompt ${missing.join(', ')} figure for ${label} in the dataset.`;
    }
  }

  return {
    modelId,
    modelLabel: label,
    isDefault,
    size,
    basis,
    measured,
    measuredIsEstimate,
    assumedInputTokens: SIZE_ASSUMPTIONS[size].inputTokens,
    assumedOutputTokens: SIZE_ASSUMPTIONS[size].outputTokens,
    energyWh,
    energySdWh,
    waterMl,
    carbonGCO2e,
    note,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post(
  '/api/search',
  rateLimit,
  async (
    req: Request<{}, {}, SearchRequest>,
    res: Response<SearchResponse | { error: string; details?: string }>
  ) => {
    const started = Date.now();
    try {
      const query = req.body?.query?.trim();
      if (!query) return res.status(400).json({ error: 'Query cannot be empty' });
      if (query.length > MAX_QUERY_CHARS) {
        return res.status(400).json({ error: `Query is too long (max ${MAX_QUERY_CHARS} characters)` });
      }
      if (embeddings.size === 0) {
        return res.status(503).json({
          error: building
            ? 'Embedding index is still being built. Try again in a minute.'
            : 'Embedding index is empty. POST /api/embeddings/rebuild to build it.',
        });
      }

      const modelId = req.body?.model || DEFAULT_MODEL_ID;
      if (modelId !== DEFAULT_MODEL_ID && !findRow(modelId)) {
        return res.status(400).json({ error: `Unknown model: ${modelId}` });
      }

      // The ONE semantic call per request (run alongside the token count).
      const [q, environmental] = await Promise.all([
        embedQuery(query),
        computeEnvironmental(query, modelId),
      ]);

      // Score against one contiguous buffer; only incidents above the threshold are
      // materialised and sorted (not all ~1,700).
      ensureMatrix();
      const mx = matrix!, dim = matrixDim;
      let topSim = -1;
      const results: IncidentWithScore[] = [];
      for (let r = 0; r < matrixRows.length; r++) {
        let similarity = 0;
        const off = r * dim;
        for (let d = 0; d < dim; d++) similarity += q[d] * mx[off + d];
        if (similarity > topSim) topSim = similarity;
        if (similarity < MIN_SIMILARITY) continue;
        const k = matrixRows[r];
        // The page only needs the id + score: it already holds the incident data. Send the
        // full record only when asked (body.full), so a broad query is not a multi-MB reply.
        results.push(
          (req.body as any)?.full
            ? ({ ...incidents[k], id: Number(incidentIds[k]), similarity, relevanceScore: Math.round(similarity * 100) } as IncidentWithScore)
            : ({ id: Number(incidentIds[k]), similarity, relevanceScore: Math.round(similarity * 100) } as IncidentWithScore)
        );
      }
      results.sort((a, b) => b.similarity - a.similarity);
      if (results.length > MAX_RESULTS) results.length = MAX_RESULTS;
      // No fallback: when nothing passes MIN_SIMILARITY the response has an empty `results`
      // array and still includes the environmental cost.

      console.log(
        `"${query}" -> ${results.length} results (top ${topSim.toFixed(3)}) ` +
          `in ${Date.now() - started}ms, index ${embeddings.size}/${incidents.length}`
      );

      const irreversibleIds = results
        .filter((r) => Number(incidentById.get(String(r.id))?.Irreversibility) >= IRREVERSIBLE_MIN)
        .map((r) => r.id);

      // Record the prompt against the caller's session (guests too; their data is
      // deleted when the session ends). Irreversible incidents are saved per user.
      let session;
      const login = currentLogin(req, store);
      if (login) {
        try {
          const open = store.ensureSession(login);
          session = store.recordPrompt(
            open.id,
            {
              text: query,
              modelId,
              modelLabel: environmental.modelLabel,
              size: environmental.size,
              energyWh: environmental.energyWh,
              waterMl: environmental.waterMl,
              carbonG: environmental.carbonGCO2e,
              envJson: JSON.stringify(environmental),
            },
            results.map((r) => ({ id: r.id, similarity: r.similarity }))
          );
          if (login.user_id != null) store.addIrreversible(login.user_id, irreversibleIds);
        } catch (dbErr) {
          console.error('Could not record prompt:', dbErr); // never fail the search over this
        }
      }

      res.json({ query, results, totalMatches: results.length, environmental, session, irreversibleIds });
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(error?.status === 429 ? 429 : 500).json({
        error: error?.status === 429 ? 'Gemini rate limit hit. Please retry shortly.' : 'Failed to process search',
        details: error?.message,
      });
    }
  }
);

app.get('/api/incidents/:id/description', (req: Request, res: Response) => {
  const inc = incidentById.get(String(req.params.id));
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ id: Number(req.params.id), description: String(inc.description ?? '') });
});

app.get('/api/incidents/:id/harmed', (req: Request, res: Response) => {
  const inc = incidentById.get(String(req.params.id));
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const raw = inc.harmed;
  const harmed = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((x) => String(x).trim())
    .filter(Boolean);
  res.json({ id: Number(req.params.id), harmed });
});

app.get('/api/models', (_req: Request, res: Response<ModelOption[]>) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const geminiRow = defaultGeminiRow();
  const shortOf = (row: any): ModelOption['short'] => {
    const c = row?.bySize?.Short;
    return { energyWh: c?.energyWh ?? null, waterMl: c?.waterMl ?? null, carbonGCO2e: c?.carbonGCO2e ?? null };
  };
  const options: ModelOption[] = [
    {
      id: DEFAULT_MODEL_ID,
      label: geminiRow ? `${geminiRow.label} (default)` : `Gemini – ${GEMINI_MODEL} (default)`,
      isDefault: true,
      short: shortOf(geminiRow),
    },
    ...getModelRows()
      .filter((r) => r !== geminiRow)
      .map((r) => ({ id: r.name, label: r.label, short: shortOf(r) })),
  ];
  res.json(options);
});

// Price a prompt on a model without searching or recording anything.
app.post('/api/cost', rateLimit, async (req: Request, res: Response) => {
  try {
    const query = String(req.body?.query ?? '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    if (query.length > MAX_QUERY_CHARS) return res.status(400).json({ error: 'query is too long' });
    res.json(await computeEnvironmental(query, req.body?.model || DEFAULT_MODEL_ID));
  } catch (err: any) {
    res.status(500).json({ error: 'Cost lookup failed', details: err?.message });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    datasetSize: incidents.length,
    embedded: embeddings.size,
    building,
    lastBuildError,
  });
});

app.post('/api/embeddings/rebuild', (_req: Request, res: Response) => {
  if (building) return res.json({ status: 'already-building', embedded: embeddings.size });
  void buildEmbeddings();
  res.json({ status: 'started', embedded: embeddings.size, total: incidents.length });
});

// ---------------------------------------------------------------------------
// Front end: serve the built page (client/dist) so "/" works when deployed
// ---------------------------------------------------------------------------
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(path.join(CLIENT_DIST, 'ai-cost.html'))) {
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      setHeaders: (res, file) => {
        // hashed build assets never change; the page itself must revalidate
        res.setHeader(
          'Cache-Control',
          file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
        );
      },
    })
  );
  app.get('/', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'ai-cost.html'));
  });
} else {
  console.warn(`No built front end at ${CLIENT_DIST}; run "npm run build". API only.`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
loadDataset();
try {
  console.log(`Loaded environmental data for ${loadEnvironmentalData(ENV_CSV_PATH)} models`);
} catch (err) {
  console.error('Could not load environmental CSV:', err);
}
loadEmbeddings();
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (embeddings.size < incidents.length) void buildEmbeddings();
});
