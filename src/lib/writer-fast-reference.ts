import type { WriterContextSnapshot } from "./writer-context";

// Only extract explicit, mechanically verifiable constraints. The generation
// prompt retains the original instructions for everything else.
export function fastWriterPlan(taskContext: string, samples: WriterContextSnapshot["samples"]): NonNullable<WriterContextSnapshot["plan"]> {
  const instruction = taskContext.split("\n\n原始资料：")[0];
  const range = instruction.match(/(\d{1,5})\s*[—–~～至到-]\s*(\d{1,5})\s*字/);
  const forbiddenTerms = [...instruction.matchAll(/(?:禁用词[：:]?|不要使用|禁止使用|不用)[「“"']?([^\s，。；、」”"'：:]{1,30})/g)]
    .slice(0, 20).map(match => ({ text: match[1], quote: match[0] }));
  return { task: { purpose: "按用户素材直接创作", facts: [], mustKeep: [], creativeFreedom: "以本次原始要求为准，内部构思，不补造事实。", timeContext: "", uncertainties: [], forbiddenTerms,
    length: range && Number(range[1]) <= Number(range[2]) && Number(range[2]) > 0 ? { min: Number(range[1]), max: Number(range[2]), quote: range[0] } : null },
    selected: samples.map(s => ({ id: s.id, reason: s.reason })), applicableStyle: [], notes: ["本地仅提取明确字数与禁用词，完整事实和要求交由正文生成阶段处理。"] };
}
