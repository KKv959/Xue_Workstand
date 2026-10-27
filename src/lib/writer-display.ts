export const LONG_DRAFT_DISPLAY_THRESHOLD = 800;

const NATURAL_PARAGRAPH_TARGET = 180;

function isStructuralLine(line: string) {
  return /^(?:#{1,6}\s|[-*+]\s+|\d+[.)、]\s*|>\s|```)/.test(line)
    || /^(?:（[^）\n]+）|\([^()\n]+\))$/.test(line);
}

function joinFragments(current: string, next: string) {
  if (!current) return next;
  const needsSpace = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(next);
  return `${current}${needsSpace ? " " : ""}${next}`;
}

function splitNaturalParagraph(text: string) {
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]+|[^。！？!?；;]+$/g) || [text];
  const paragraphs: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    current = joinFragments(current, sentence.trim());
    if (current.length >= NATURAL_PARAGRAPH_TARGET && /[。！？!?；;]$/.test(sentence.trim())) {
      paragraphs.push(current);
      current = "";
    }
  }

  if (current) paragraphs.push(current);
  return paragraphs;
}

/**
 * Formats only the display copy for long drafts; the saved draft remains untouched.
 */
export function formatLongDraftForDisplay(content: string) {
  if (content.replace(/\s/g, "").length <= LONG_DRAFT_DISPLAY_THRESHOLD) return content;

  const blocks: string[] = [];
  let ordinaryLines: string[] = [];
  const flushOrdinary = () => {
    if (!ordinaryLines.length) return;
    const joined = ordinaryLines.reduce(joinFragments, "");
    blocks.push(...splitNaturalParagraph(joined));
    ordinaryLines = [];
  };

  for (const rawLine of content.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isStructuralLine(line)) {
      flushOrdinary();
      blocks.push(line);
    } else {
      ordinaryLines.push(line);
    }
  }
  flushOrdinary();

  return blocks.join("\n\n");
}
