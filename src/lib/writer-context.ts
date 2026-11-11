import { z } from "zod";

export { WRITER_PROMPT_VERSION } from "./writer-prompts";
const text = z.string().trim().min(1);
const legacyEvidence = z.object({ quote: text, action: text, when: text, avoid: z.string() });
const legacyNarrativeSchema = z.object({
  forms: z.array(text).min(1),
  beats: z.array(z.object({ purpose: text, quote: text })).min(1),
  bridges: z.array(z.object({
    before: text, after: text, action: text, requires: text
  }))
});

export const styleEvidenceSchema = z.object({
  summary: text,
  quotes: z.array(text).default([])
});
export type StyleEvidence = z.infer<typeof styleEvidenceSchema>;

const legacyStyleEvidenceSchema = z.object({
  genre: text,
  purposes: z.array(text).min(1),
  unsuitable: z.array(text),
  structure: text,
  narrative: legacyNarrativeSchema.optional(),
  moves: z.array(legacyEvidence).min(1),
  limitations: z.array(text)
});
export const storedStyleEvidenceSchema = z.union([styleEvidenceSchema, legacyStyleEvidenceSchema]);
export type StoredStyleEvidence = z.infer<typeof storedStyleEvidenceSchema>;

const sourcedText = z.object({ text: text.max(1000), quote: text.max(2000) });
export const writerTaskSchema = z.object({
  purpose: text.max(300),
  facts: z.array(sourcedText).max(20),
  mustKeep: z.array(sourcedText).max(20),
  creativeFreedom: text.max(1000),
  timeContext: z.string().max(500),
  uncertainties: z.array(text.max(500)).max(12),
  forbiddenTerms: z.array(sourcedText).max(20),
  length: z.object({ min: z.number().int().min(0), max: z.number().int().positive(), quote: text }).refine(v => v.min <= v.max, "字数上下限无效").nullable()
});
export type WriterTask = z.infer<typeof writerTaskSchema>;

export const writerPlanSchema = z.object({
  task: writerTaskSchema,
  selected: z.array(z.object({ id: text, reason: text })),
  applicableStyle: z.array(text.max(700)).max(10),
  notes: z.array(text.max(500)).max(12)
});
export type WriterPlan = z.infer<typeof writerPlanSchema>;

export const writerContextSchema = z.object({
  schemaVersion: z.literal(1),
  promptVersion: text,
  referenceKey: text,
  styleText: z.string(),
  styleHash: text,
  samples: z.array(z.object({ id: text, title: z.string(), text: text, hash: text, reason: z.string() })),
  plan: writerPlanSchema.nullable(),
  notes: z.array(z.string()),
  preparedAt: text,
  preparationModel: z.string().optional(),
  compatibility: z.literal("legacy-current-style").optional()
});
export type WriterContextSnapshot = z.infer<typeof writerContextSchema>;

export function parseModelJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new Error(`${label}返回的结构无效，请重试；已有结果未被替换。`);
  }
}

export function parseStyleEvidence(value: string, transcript: string, title: string): StyleEvidence {
  const parsed = styleEvidenceSchema.safeParse(parseModelJson(value, `样本「${title}」分析`));
  if (!parsed.success) throw new Error(`样本「${title}」分析缺少讲法概括，请重试。`);
  if (styleEvidenceQuotes(parsed.data).some(quote => !transcript.includes(quote))) {
    throw new Error(`样本「${title}」的风格引句无法在原文定位，请重新分析该样本。`);
  }
  return parsed.data;
}

export function styleEvidenceQuotes(analysis: StyleEvidence) {
  return [...new Set(analysis.quotes)];
}

export function styleEvidencePassages(analysis: StyleEvidence, transcript: string) {
  const quotes = styleEvidenceQuotes(analysis);
  const ranges = quotes.map(quote => {
    const start = transcript.indexOf(quote);
    if (start < 0) throw new Error("风格证据无法在原文定位，原卡已保留，请重新分析。");
    return { start, end: start + quote.length };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    // Join only overlap or whitespace between verified quotes, keeping the exact original text.
    // Bound additional passages so a dense set of annotations does not re-insert a whole long transcript.
    if (previous && range.end - previous.start <= 1500 && (range.start <= previous.end || !transcript.slice(previous.end, range.start).trim())) {
      previous.end = Math.max(previous.end, range.end);
    } else merged.push({ ...range });
  }
  return [...new Set([...quotes, ...merged.map(range => transcript.slice(range.start, range.end))])];
}

export type StyleCardEvidence = { sourceId: string; quote: string; workHash?: string };

export function validateStyleCardCitations(
  style: string,
  evidenceQuotes?: StyleCardEvidence[]
) {
  if (!style.trim()) throw new Error("风格卡内容为空，原卡已保留，请重新归纳。");
  const invalidCitation = () => new Error("风格卡原文引用无效或改写了证据，原卡已保留，请重新归纳。");
  const marker = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(style))) {
    const sourceId = match[1];
    const quotes = (evidenceQuotes || []).filter(item => item.sourceId === sourceId).map(item => item.quote);
    if (!quotes.length) throw invalidCitation();
    // A known bare source ID is a bibliography pointer, not supporting evidence for a rule.
    if (style[marker.lastIndex] !== "「") continue;
    const start = marker.lastIndex + 1;
    const maxLength = Math.max(0, ...quotes.map(quote => normalizeCitationMarkdown(quote).length));
    let end = style.indexOf("」", start);
    let verifiedEnd = -1;
    // Quotes may themselves contain 「」. Choose the longest verified continuous excerpt.
    while (end >= 0) {
      const excerpt = style.slice(start, end);
      const normalizedExcerpt = normalizeCitationMarkdown(excerpt);
      if (normalizedExcerpt.length > maxLength) break;
      if (normalizedExcerpt.trim() && quotes.some(quote => normalizeCitationMarkdown(quote).includes(normalizedExcerpt))) verifiedEnd = end;
      end = style.indexOf("」", end + 1);
    }
    if (verifiedEnd < 0) throw invalidCitation();
    marker.lastIndex = verifiedEnd + 1;
  }
}

function normalizeCitationMarkdown(value: string) {
  return value.replace(/[ \t]+\r?\n/g, "\n");
}
