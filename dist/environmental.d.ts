import type { SizeBucket } from './types/index.js';
export declare const SIZES: SizeBucket[];
/** The benchmark scenarios the dataset was measured with. */
export declare const SIZE_ASSUMPTIONS: Record<SizeBucket, {
    inputTokens: number;
    outputTokens: number;
    approxInputWords: number;
}>;
export declare function bucketFromTokens(tokens: number): SizeBucket;
export declare function bucketFromWords(words: number): SizeBucket;
export declare function countWords(text: string): number;
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
export declare function loadEnvironmentalData(csvPath: string): number;
export declare const getModelRows: () => ModelCostRow[];
export declare const findRow: (name: string) => ModelCostRow | undefined;
export declare const isGeminiRow: (r: ModelCostRow) => boolean;
/**
 * The dataset row that represents the app's default (Gemini) model.
 * Order: exact name from `preferredName` (env override) -> a Gemini "AI Studio" row
 * (this app calls the Gemini API with an AI Studio key) -> first Gemini row.
 */
export declare function findDefaultGeminiRow(preferredName?: string): ModelCostRow | undefined;
//# sourceMappingURL=environmental.d.ts.map