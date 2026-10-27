const taskProgressPrefixes = [
  "正在生成",
  "正在转写",
  "正在读取",
  "正在检查",
  "正在保存",
  "正在处理",
  "正在整理",
  "正在准备",
  "正在预取",
  "正在校验",
  "正在写入",
  "正在切换"
];

export function isTaskProgressMessage(message: string) {
  const normalized = message.trim();
  if (!normalized) return false;

  return (
    normalized.includes("已在后台开始") ||
    normalized === "任务已加入队列" ||
    normalized === "任务正在运行" ||
    taskProgressPrefixes.some((prefix) => normalized.startsWith(prefix))
  );
}
