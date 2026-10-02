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
}

export type SizeBucket = 'Short' | 'Medium' | 'Long';

export interface EnvironmentalCost {
  modelId: string;
  modelLabel: string;
  isDefault: boolean;
  size: SizeBucket;
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

export interface ChatMessage {
  id: number;
  type: 'user' | 'bot';
  text: string;
  timestamp: Date;
  results?: IncidentWithScore[];
  environmental?: EnvironmentalCost;
}

export interface SearchResponse {
  query: string;
  results: IncidentWithScore[];
  totalMatches: number;
  environmental?: EnvironmentalCost;
}
