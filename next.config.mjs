/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.WORKSPACE_DEV_SANDBOX === "1" ? ".dev-sandbox/next" : ".next",
  reactStrictMode: true,
  devIndicators: false,
  output: "standalone",
  serverExternalPackages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
  outputFileTracingIncludes: {
    "/api/pi-settings/login": ["./node_modules/@earendil-works/pi-ai/dist/auth/oauth/**/*"]
  },
  turbopack: { moduleIds: "named" }
};

export default nextConfig;
