import { z } from "zod";
export const imagePromptAssistSchema = z.object({
  prompt: z.string().trim().min(1, "先写下画面想法，再让 AI 润色。").max(12000),
  mode: z.enum(["polish", "suggest"]),
});
export type ImagePromptAssistInput = z.infer<typeof imagePromptAssistSchema>;
export const imagePromptAssistResultSchema = z.object({ text: z.string().min(1).max(12000), model: z.string(), fallback: z.boolean(), fallbackReason: z.string().optional() });
