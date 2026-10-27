import { getAppMode } from "@/lib/app-mode";
import { GrossMarginWorkbench } from "./_components/GrossMarginWorkbench";

export default function GrossMarginPage() {
  return <GrossMarginWorkbench appMode={getAppMode()} />;
}
