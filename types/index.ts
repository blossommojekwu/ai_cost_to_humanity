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

export interface SearchRequest {
  query: string;
}

export interface SearchResponse {
  query: string;
  results: IncidentWithScore[];
  totalMatches: number;
}

export interface HealthResponse {
  status: string;
  datasetSize: number;
}
