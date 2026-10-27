import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { collectAccountContent } from "@/lib/account-collection";
import { collectOrders, platforms } from "@/lib/types";

export const runtime = "nodejs";

const collectOrderSchemaValues = [...collectOrders, "like", "click", "stow"] as const;
const schema = z.object({
  platform: z.enum(platforms),
  name: z.string().min(1),
  uidOrUrl: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  order: z.enum(collectOrderSchemaValues).default("likes"),
  fromDate: z.string().optional(),
  toDate: z.string().optional()
});

export async function POST(request: Request) {
  return apiJson(async () => collectAccountContent(
    await parseJsonBody(request, schema),
    { signal: request.signal }
  ), {
    fallbackMessage: "采集失败"
  });
}
