import { ImageResponse } from "next/og";
import { AppIconArtwork } from "./app-icon-artwork";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<AppIconArtwork size={size.width} />, size);
}
