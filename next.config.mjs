/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.WORKSPACE_DEV_SANDBOX === "1" ? ".dev-sandbox/next" : ".next",
  reactStrictMode: true,
  devIndicators: false,
  output: "standalone",
  turbopack: { moduleIds: "named" }
};

export default nextConfig;
