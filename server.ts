import express, { Request, Response } from 'express';
import cors from 'cors';
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Works from both ./server.ts (tsx) and ./dist/server.js (compiled)
const ROOT = fs.existsSync(path.join(__dirname, 'data')) ? __dirname : path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'ai_incidents.json');
const EMBEDDINGS_PATH = path.join(ROOT, 'data', 'embeddings.json');

const app = express();
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

app.use(cors());
app.use(express.json());

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
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const res = await withRetry(() =>
    model.embedContent({
      content: { role: 'user', parts: [{ text }] },
      taskType: TaskType.RETRIEVAL_QUERY,
    })
  );
  return normalise(res.embedding.values);
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
  async (
    req: Request<{}, {}, SearchRequest>,
    res: Response<SearchResponse | { error: string; details?: string }>
  ) => {
    const started = Date.now();
    try {
      const query = req.body?.query?.trim();
      if (!query) return res.status(400).json({ error: 'Query cannot be empty' });
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

      const scored: IncidentWithScore[] = [];
      for (let k = 0; k < incidents.length; k++) {
        const vec = embeddings.get(incidentIds[k]);
        if (!vec) continue;
        const similarity = dot(q, vec);
        scored.push({
          ...incidents[k],
          id: Number(incidentIds[k]),
          similarity,
          relevanceScore: Math.round(similarity * 100),
        } as IncidentWithScore);
      }
      scored.sort((a, b) => b.similarity - a.similarity);

      const results = scored.filter((r) => r.similarity >= MIN_SIMILARITY).slice(0, MAX_RESULTS);
      // No fallback: when nothing passes MIN_SIMILARITY the response has an empty `results`
      // array and still includes the environmental cost.

      console.log(
        `"${query}" -> ${results.length} results (top ${scored[0]?.similarity.toFixed(3)}) ` +
          `in ${Date.now() - started}ms, index ${embeddings.size}/${incidents.length}`
      );

      res.json({ query, results, totalMatches: results.length, environmental });
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(error?.status === 429 ? 429 : 500).json({
        error: error?.status === 429 ? 'Gemini rate limit hit. Please retry shortly.' : 'Failed to process search',
        details: error?.message,
      });
    }
  }
);

app.get('/api/incidents/:id/harmed', (req: Request, res: Response) => {
  const inc = incidentById.get(String(req.params.id));
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const raw = inc.harmed;
  const harmed = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((x) => String(x).trim())
    .filter(Boolean);
  res.json({ id: Number(req.params.id), harmed });
});

app.get('/api/models', (_req: Request, res: Response<ModelOption[]>) => {
  const geminiRow = defaultGeminiRow();
  const options: ModelOption[] = [
    {
      id: DEFAULT_MODEL_ID,
      label: geminiRow ? `${geminiRow.label} (default)` : `Gemini – ${GEMINI_MODEL} (default)`,
      isDefault: true,
    },
    ...getModelRows()
      .filter((r) => r !== geminiRow)
      .map((r) => ({ id: r.name, label: r.label })),
  ];
  res.json(options);
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
