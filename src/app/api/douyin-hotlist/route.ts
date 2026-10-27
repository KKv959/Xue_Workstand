import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import {
  addDouyinHotlistAccount,
  getDouyinHotlist,
  refreshDouyinHotlist,
  removeDouyinHotlistAccount
} from "@/lib/douyin-hotlist";
import { platforms } from "@/lib/types";
import { deleteDouyinHotlistGroup, saveDouyinHotlistGroup } from "@/lib/storage/douyin-hotlist";

export const runtime = "nodejs";

const getSchema = z.object({
  force: z.boolean().optional(),
  windowDays: z.coerce.number().int().min(1).max(14).optional(),
  window: z.string().optional()
});

const postSchema = z.object({
  action: z.enum(["addAccount", "removeAccount", "refresh", "saveGroup", "deleteGroup"]),
  groupId: z.string().uuid().optional(),
  name: z.string().trim().min(1, "请输入分组名称。").max(40, "分组名称不能超过 40 个字符。").optional(),
  revision: z.number().int().nonnegative().optional(),
  platform: z.enum(platforms).optional(),
  query: z.string().optional(),
  accountId: z.string().optional(),
  accountIds: z.array(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(120).optional(),
  windowDays: z.coerce.number().int().min(1).max(14).optional(),
  window: z.string().optional()
});

export async function GET(request: Request) {
  return apiJson(async () => {
    const { searchParams } = new URL(request.url);
    const input = getSchema.parse({
      force: searchParams.get("force") === "1",
      windowDays: searchParams.get("windowDays") || undefined,
      window: searchParams.get("window") || undefined
    });
    return getDouyinHotlist({
      force: input.force,
      windowDays: input.windowDays,
      windowKey: input.window
    });
  }, {
    fallbackMessage: "读取视频热榜失败"
  });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, postSchema);

    if (input.action === "deleteGroup") {
      await deleteDouyinHotlistGroup({
        id: z.string().uuid("请选择要删除的分组。").parse(input.groupId),
        revision: z.number().int().nonnegative().parse(input.revision)
      });
      return getDouyinHotlist({ windowKey: input.window });
    }

    if (input.action === "saveGroup") {
      await saveDouyinHotlistGroup({
        id: input.groupId,
        name: z.string().min(1, "请输入分组名称。").parse(input.name),
        accountIds: z.array(z.string()).parse(input.accountIds),
        revision: z.number().int().nonnegative().parse(input.revision)
      });
      return getDouyinHotlist({ windowKey: input.window });
    }

    if (input.action === "addAccount") {
      return addDouyinHotlistAccount({
        platform: input.platform || "douyin",
        query: z.string().min(1, "请输入账号名、主页链接或平台 ID。").parse(input.query),
        signal: request.signal,
        windowDays: input.windowDays,
        windowKey: input.window
      });
    }

    if (input.action === "removeAccount") {
      return removeDouyinHotlistAccount(
        z.string().min(1, "缺少要移除的账号。").parse(input.accountId),
        { windowDays: input.windowDays, windowKey: input.window }
      );
    }

    return refreshDouyinHotlist({
      accountIds: input.accountIds,
      limit: input.limit,
      windowDays: input.windowDays,
      windowKey: input.window,
      signal: request.signal
    });
  }, {
    fallbackMessage: "更新视频热榜失败"
  });
}
