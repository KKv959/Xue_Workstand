import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "账号风格库私人工作台",
    short_name: "风格库",
    description: "远程查看热榜、管理转写稿并生成文案。",
    start_url: "/mobile",
    display: "standalone",
    background_color: "#f2f4f7",
    theme_color: "#f2f4f7",
    orientation: "any",
    icons: [
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
