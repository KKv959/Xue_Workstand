import { ImageResponse } from "next/og";
import { AppIconArtwork } from "./app-icon-artwork";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<AppIconArtwork size={size.width} />, size);
}
