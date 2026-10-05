export interface AIIncident {
  id: number;
  title?: string;
  description?: string;
  content?: string;
  date?: string;
  category?: string;
  severity?: string;
  [key: string]: unknown;
}

export interface IncidentWithScore extends AIIncident {
  similarity: number;
  relevanceScore: number;
  finalScore?: number;
}

export type SizeBucket = 'Short' | 'Medium' | 'Long';

export interface EnvironmentalCost {
  modelId: string;
  modelLabel: string;
  isDefault: boolean;
  size: SizeBucket;
  /** What `measured` is: Gemini token count, or word count for other models. */
  basis: 'tokens' | 'words';
  measured: number;
  measuredIsEstimate?: boolean;
  assumedInputTokens: number;
  assumedOutputTokens: number;
  energyWh: number | null;
  energySdWh: number | null;
  waterMl: number | null;
  carbonGCO2e: number | null;
  note?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface SearchRequest {
  query: string;
  model?: string;
}

export interface SessionSummary {
  id: number;
  promptCount: number;
  totalEnergyWh: number;
  totalWaterMl: number;
  totalCarbonG: number;
}

export interface SearchResponse {
  query: string;
  results: IncidentWithScore[];
  totalMatches: number;
  environmental?: EnvironmentalCost;
  /** Running totals for the signed-in (or guest) session, when there is one. */
  session?: SessionSummary;
  /** IDs of matched incidents that meet the irreversibility rule. */
  irreversibleIds?: number[];
}

export interface HealthResponse {
  status: string;
  datasetSize: number;
}
