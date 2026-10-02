import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
app.use(cors());
app.use(express.json());
let incidents = [];
const incidentIds = [];
// id -> L2-normalised embedding (so cosine similarity == dot product)
const embeddings = new Map();
let building = false;
let lastBuildError = null;
// Similarity above which a result is returned. Embedding cosine scores for
// related text with gemini-embedding-001 typically fall in the 0.5-0.8 range,
// so this is deliberately lower than a "percentage match" intuition suggests.
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY ?? 0.55);
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 20);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getId(i) {
    return String(i['Incident ID'] ?? i.id);
}
/** Text that represents an incident for embedding: content + Tags + Risk Subdomain. */
function incidentText(i) {
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
function normalise(values) {
    const v = Float32Array.from(values);
    let sum = 0;
    for (let k = 0; k < v.length; k++)
        sum += v[k] * v[k];
    const norm = Math.sqrt(sum) || 1;
    for (let k = 0; k < v.length; k++)
        v[k] /= norm;
    return v;
}
function dot(a, b) {
    let s = 0;
    for (let k = 0; k < a.length; k++)
        s += a[k] * b[k];
    return s;
}
function retryDelayMs(err) {
    const info = (err?.errorDetails ?? []).find((d) => String(d['@type']).includes('RetryInfo'));
    const m = info?.retryDelay?.match?.(/^(\d+(?:\.\d+)?)s$/);
    return m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : null;
}
async function withRetry(fn, attempts = 6) {
    let backoff = 2000;
    for (let n = 1;; n++) {
        try {
            return await fn();
        }
        catch (err) {
            if (n >= attempts || ![429, 500, 503].includes(err?.status))
                throw err;
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
async function embedQuery(text) {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const res = await withRetry(() => model.embedContent({
        content: { role: 'user', parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_QUERY,
    }));
    return normalise(res.embedding.values);
}
async function embedDocuments(texts) {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const res = await withRetry(() => model.batchEmbedContents({
        requests: texts.map((text) => ({
            content: { role: 'user', parts: [{ text }] },
            taskType: TaskType.RETRIEVAL_DOCUMENT,
        })),
    }));
    return res.embeddings.map((e) => normalise(e.values));
}
// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadEmbeddings() {
    if (!fs.existsSync(EMBEDDINGS_PATH))
        return;
    try {
        const raw = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
        for (const [id, vec] of Object.entries(raw))
            embeddings.set(id, normalise(vec));
        console.log(`Loaded ${embeddings.size} cached embeddings`);
    }
    catch (err) {
        console.error('Failed to read embeddings cache:', err);
    }
}
function saveEmbeddings() {
    const out = {};
    for (const [id, vec] of embeddings)
        out[id] = Array.from(vec, (x) => Math.round(x * 1e6) / 1e6);
    fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(out));
}
function loadDataset() {
    incidents = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    incidentIds.length = 0;
    for (const i of incidents)
        incidentIds.push(getId(i));
    console.log(`Loaded ${incidents.length} AI incidents`);
}
// ---------------------------------------------------------------------------
// Embedding index build (batched, resumable)
// ---------------------------------------------------------------------------
const BATCH_SIZE = 100;
async function buildEmbeddings() {
    if (building)
        return;
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
    }
    catch (err) {
        lastBuildError = err?.message ?? String(err);
        console.error('Embedding build stopped:', lastBuildError);
    }
    finally {
        building = false;
    }
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/api/search', async (req, res) => {
    const started = Date.now();
    try {
        const query = req.body?.query?.trim();
        if (!query)
            return res.status(400).json({ error: 'Query cannot be empty' });
        if (embeddings.size === 0) {
            return res.status(503).json({
                error: building
                    ? 'Embedding index is still being built. Try again in a minute.'
                    : 'Embedding index is empty. POST /api/embeddings/rebuild to build it.',
            });
        }
        // The ONE semantic call per request.
        const q = await embedQuery(query);
        const scored = [];
        for (let k = 0; k < incidents.length; k++) {
            const vec = embeddings.get(incidentIds[k]);
            if (!vec)
                continue;
            const similarity = dot(q, vec);
            scored.push({
                ...incidents[k],
                id: Number(incidentIds[k]),
                similarity,
                relevanceScore: Math.round(similarity * 100),
            });
        }
        scored.sort((a, b) => b.similarity - a.similarity);
        let results = scored.filter((r) => r.similarity >= MIN_SIMILARITY).slice(0, MAX_RESULTS);
        // Never return nothing when we have an index: show the closest few.
        if (results.length === 0)
            results = scored.slice(0, 5);
        console.log(`"${query}" -> ${results.length} results (top ${scored[0]?.similarity.toFixed(3)}) ` +
            `in ${Date.now() - started}ms, index ${embeddings.size}/${incidents.length}`);
        res.json({ query, results, totalMatches: results.length });
    }
    catch (error) {
        console.error('Search error:', error);
        res.status(error?.status === 429 ? 429 : 500).json({
            error: error?.status === 429 ? 'Gemini rate limit hit. Please retry shortly.' : 'Failed to process search',
            details: error?.message,
        });
    }
});
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        datasetSize: incidents.length,
        embedded: embeddings.size,
        building,
        lastBuildError,
    });
});
app.post('/api/embeddings/rebuild', (_req, res) => {
    if (building)
        return res.json({ status: 'already-building', embedded: embeddings.size });
    void buildEmbeddings();
    res.json({ status: 'started', embedded: embeddings.size, total: incidents.length });
});
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
loadDataset();
loadEmbeddings();
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (embeddings.size < incidents.length)
        void buildEmbeddings();
});
//# sourceMappingURL=server.js.map