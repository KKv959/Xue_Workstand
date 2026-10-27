import { redirect } from "next/navigation";
import { isGrossMarginAppMode } from "@/lib/app-mode";

export default function HomePage() {
  redirect(isGrossMarginAppMode() ? "/gross-margin" : "/douyin-hotlist");
}
