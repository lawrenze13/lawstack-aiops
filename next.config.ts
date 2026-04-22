import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 has a native binding; webpack must not try to bundle it.
  // bindings + file-uri-to-path are transitive deps that also need exclusion.
  serverExternalPackages: ["better-sqlite3", "bindings", "file-uri-to-path"],
  // HeroUI v3 ships ESM with many small component packages. These options
  // let Next tree-shake individual component imports and compile any
  // remaining TS/ESM in @heroui/react's published build.
  experimental: {
    optimizePackageImports: ["@heroui/react"],
  },
  transpilePackages: ["@heroui/react"],
  // Phase 4 will configure logging + headers; left minimal for Phase 1.
};

export default nextConfig;
