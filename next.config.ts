import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 has a native binding; webpack must not try to bundle it.
  // bindings + file-uri-to-path are transitive deps that also need exclusion.
  serverExternalPackages: ["better-sqlite3", "bindings", "file-uri-to-path"],
  // Phase 4 will configure logging + headers; left minimal for Phase 1.
};

export default nextConfig;
