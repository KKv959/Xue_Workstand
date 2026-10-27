export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(
    {
      error: "完整素材库接口已停用，请改用 /api/library/overview 和各资源的按需接口。"
    },
    { status: 410 }
  );
}
