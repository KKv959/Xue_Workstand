export type TrendRadarItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceId: string;
  publishedAt?: string;
  observedAt?: string;
  summary?: string;
  rank?: number;
  isNew: boolean;
  kind: "hotlist" | "rss";
};
export type TrendRadarFeed = {
  items: TrendRadarItem[];
  generatedAt: string;
  warnings: string[];
  available: boolean;
  missing: string[];
  counts: { hotlist: number; rss: number; newItems: number };
};
