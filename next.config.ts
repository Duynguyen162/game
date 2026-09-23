import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  transpilePackages: ["@game/shared"],
  turbopack: {
    root: path.resolve(__dirname, ".."),
    resolveAlias: {
      "@game/shared": "../shared/src/index.ts",
    },
  },
};

export default nextConfig;
