import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AIIncident,
  IncidentWithScore,
  SearchRequest,
  SearchResponse,
  HealthResponse,
} from './types/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Gemini API
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error('GEMINI_API_KEY environment variable is not set');
}
const genAI = new GoogleGenerativeAI(apiKey);

// Middleware
app.use(cors());
app.use(express.json());

// State
let incidentsDataset: AIIncident[] = [];

/**
 * Load AI incidents dataset from JSON file
 */
function loadDataset(): void {
  try {
    const dataPath = path.join(__dirname, 'data', 'ai_incidents.json');
    if (fs.existsSync(dataPath)) {
      const rawData = fs.readFileSync(dataPath, 'utf8');
      incidentsDataset = JSON.parse(rawData);
      console.log(`Loaded ${incidentsDataset.length} AI incidents`);
    }
  } catch (error) {
    console.error('Error loading dataset:', error);
  }
}

/**
 * Generate embedding using Gemini API
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: 'embedding-001' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (normA * normB);
}

/**
 * POST /api/search - Search for incidents related to a query
 */
app.post('/api/search', async (req: Request<{}, {}, SearchRequest>, res: Response<SearchResponse | { error: string; details?: string }>) => {
  try {
    const { query } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ error: 'Query cannot be empty' });
    }

    if (incidentsDataset.length === 0) {
      return res.status(500).json({ error: 'Dataset not loaded' });
    }

    // Generate embedding for the query
    console.log('Generating embedding for query:', query);
    const queryEmbedding = await generateEmbedding(query);

    // Generate embeddings for dataset items and calculate similarity
    const results: IncidentWithScore[] = [];
    for (const incident of incidentsDataset) {
      const incidentText = `${incident.title || ''} ${incident.description || ''} ${incident.content || ''}`.trim();

      if (!incidentText) continue;

      const incidentEmbedding = await generateEmbedding(incidentText);
      const similarity = cosineSimilarity(queryEmbedding, incidentEmbedding);

      results.push({
        ...incident,
        similarity: similarity,
        relevanceScore: Math.round(similarity * 100),
      });
    }

    // Sort by similarity and return top results
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, 10);

    res.json({
      query: query,
      results: topResults,
      totalMatches: results.length,
    });
  } catch (error) {
    console.error('Search error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to process search', details: errorMessage });
  }
});

/**
 * GET /api/health - Health check endpoint
 */
app.get('/api/health', (_req: Request, res: Response<HealthResponse>) => {
  res.json({
    status: 'ok',
    datasetSize: incidentsDataset.length,
  });
});

/**
 * Start server
 */
loadDataset();
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
