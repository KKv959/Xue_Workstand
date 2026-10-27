export interface RadarSource { id: string; name: string; url: string; type: string; scope: string; tier?: string; itemLimit?: number }
export interface RadarSignal { id: string; sourceId: string; source: string; originalSource: string; title: string; summary: string; url: string; category: string; publishedAt: string; collectedAt: string; coarseScore?: number; coarseReasons?: string[]; modelCoarseReason?: string; related?: RadarSignal[]; inputKind?: "hotlist" | "rss" | "video"; observedAt?: string; metrics?: { rank?: number; likes?: number; comments?: number; views?: number }; eventId?: string; development?: string; previousContext?: { title: string; summary: string }; eventFingerprint?: string }
export function coarseFilter(items: RadarSignal[]): RadarSignal[];
export function isLowValueRoutineSports(item: RadarSignal): boolean;
export function sameHotspotEvent(a: RadarSignal, b: RadarSignal): boolean;
export function sameEvent(a: string, b: string, aDate: string, bDate: string): boolean;
export function isRecentVerifiedSignal(item: {publishedAt?: string}): boolean;
