import fs from 'fs';
import type { SizeBucket } from './types/index.js';

export const SIZES: SizeBucket[] = ['Short', 'Medium', 'Long'];

/** The benchmark scenarios the dataset was measured with. */
export const SIZE_ASSUMPTIONS: Record<
  SizeBucket,
  { inputTokens: number; outputTokens: number; approxInputWords: number }
> = {
  Short: { inputTokens: 100, outputTokens: 300, approxInputWords: 67 },
  Medium: { inputTokens: 1000, outputTokens: 1000, approxInputWords: 667 },
  Long: { inputTokens: 10000, outputTokens: 1500, approxInputWords: 6667 },
};

// Sizes grow ~10x per step, so bucket boundaries are the geometric midpoints
// (e.g. 100 and 1,000 tokens -> 316).
const geoMid = (a: number, b: number): number => Math.sqrt(a * b);

export function bucketFromTokens(tokens: number): SizeBucket {
  const s = SIZE_ASSUMPTIONS;
  if (tokens <= geoMid(s.Short.inputTokens, s.Medium.inputTokens)) return 'Short';
  if (tokens <= geoMid(s.Medium.inputTokens, s.Long.inputTokens)) return 'Medium';
  return 'Long';
}

export function bucketFromWords(words: number): SizeBucket {
  const s = SIZE_ASSUMPTIONS;
  if (words <= geoMid(s.Short.approxInputWords, s.Medium.approxInputWords)) return 'Short';
  if (words <= geoMid(s.Medium.approxInputWords, s.Long.approxInputWords)) return 'Medium';
  return 'Long';
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------
export interface SizeCost {
  energyWh: number | null;
  energySdWh: number | null;
  waterMl: number | null;
  carbonGCO2e: number | null;
}

export interface ModelCostRow {
  /** Name exactly as in the CSV (used as the model id). */
  name: string;
  /** Name without footnote markers (* / †), for display. */
  label: string;
  bySize: Record<SizeBucket, SizeCost>;
}

let rows: ModelCostRow[] = [];

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      out.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

export function loadEnvironmentalData(csvPath: string): number {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim());

  // Columns are located by header text, not position.
  const sizeKey: Record<SizeBucket, string> = { Short: '(100 input', Medium: '(1k input', Long: '(10k input' };
  const find = (metric: string, size: SizeBucket): number =>
    header.findIndex((h) => h.includes(metric) && h.includes(sizeKey[size]));

  const cols = SIZES.map((size) => ({
    size,
    energy: find('Energy Consumption Mean', size),
    sd: find('Energy Consumption SD', size),
    water: find('Water', size),
    carbon: find('Carbon', size),
  }));
  for (const c of cols) {
    for (const [metric, idx] of Object.entries({ energy: c.energy, water: c.water, carbon: c.carbon })) {
      if (idx < 0) console.warn(`Environmental CSV: no "${metric}" column found for ${c.size} prompts`);
    }
  }

  const num = (row: string[], idx: number): number | null => {
    if (idx < 0) return null;
    const v = parseFloat((row[idx] ?? '').trim());
    return Number.isFinite(v) ? v : null;
  };

  const parsed: ModelCostRow[] = [];
  for (const row of table.slice(1)) {
    const name = (row[0] ?? '').trim();
    // Model rows end at the first blank row / the "Notes:" block.
    if (!name || /^notes?:?$/i.test(name)) break;
    const bySize = {} as Record<SizeBucket, SizeCost>;
    for (const c of cols) {
      bySize[c.size] = {
        energyWh: num(row, c.energy),
        energySdWh: num(row, c.sd),
        waterMl: num(row, c.water),
        carbonGCO2e: num(row, c.carbon),
      };
    }
    parsed.push({ name, label: name.replace(/[*†]+$/, '').trim(), bySize });
  }
  rows = parsed;
  return rows.length;
}

export const getModelRows = (): ModelCostRow[] => rows;
export const findRow = (name: string): ModelCostRow | undefined => rows.find((r) => r.name === name);
export const isGeminiRow = (r: ModelCostRow): boolean => /^gemini/i.test(r.label);

/**
 * The dataset row that represents the app's default (Gemini) model.
 * Order: exact name from `preferredName` (env override) -> a Gemini "AI Studio" row
 * (this app calls the Gemini API with an AI Studio key) -> first Gemini row.
 */
export function findDefaultGeminiRow(preferredName?: string): ModelCostRow | undefined {
  if (preferredName) {
    const exact = rows.find((r) => r.name === preferredName || r.label === preferredName);
    if (exact) return exact;
    console.warn(`DEFAULT_ENV_MODEL "${preferredName}" not found in the environmental CSV; using fallback.`);
  }
  const gemini = rows.filter(isGeminiRow);
  return gemini.find((r) => /ai studio/i.test(r.name)) ?? gemini[0];
}
