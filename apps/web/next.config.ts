import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The server never advertises the framework.
  poweredByHeader: false,
  // The audio route reads at most 256 KB itself; Server Actions carry text only.
  experimental: { serverActions: { bodySizeLimit: "32kb" } },
};

export default nextConfig;
