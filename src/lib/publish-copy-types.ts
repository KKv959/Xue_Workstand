import type { Platform } from "./types";

export type PublishCopyTargetPlatform = Platform | "both";

export type PublishCopyInput = {
  platform: PublishCopyTargetPlatform;
  sourceText: string;
  topicHint?: string;
  candidateCount?: number;
};

export type PublishCopyReference = {
  id: string;
  platform: Platform;
  query: string;
  title: string;
  caption: string;
  author?: string;
  url: string;
  stats?: {
    views?: number;
    likes?: number;
    comments?: number;
    favorites?: number;
    shares?: number;
  };
  score: number;
};

export type PublishCopyFramework = {
  name: string;
  titlePattern: string;
  captionPattern: string;
  openingMove: string;
  structure: string;
  reusableSlots: string[];
  fitReason: string;
};

export type PublishCopyCandidate = {
  title: string;
  caption: string;
  platform: PublishCopyTargetPlatform;
  angle: string;
  frameworkName: string;
};

export type PublishCopyResult = {
  generatedAt: string;
  platform: PublishCopyTargetPlatform;
  sourceSummary: string;
  queryPlan: {
    topic: string;
    queries: string[];
    querySource: "model" | "local";
    fallbackReason?: string;
  };
  research: {
    usedQueries: string[];
    failedQueries: string[];
    referenceCount: number;
    references: PublishCopyReference[];
  };
  frameworks: PublishCopyFramework[];
  candidates: PublishCopyCandidate[];
  usedModel: string;
  fallback: boolean;
  fallbackReason?: string;
};
