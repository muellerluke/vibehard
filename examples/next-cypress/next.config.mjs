/** @type {import('next').NextConfig} */
const nextConfig = {
  // Client coverage here comes from Istanbul instrumentation (.babelrc),
  // but keep browser maps on so client chunks stay debuggable.
  productionBrowserSourceMaps: true,
  webpack(config, { isServer }) {
    // Webpack production builds emit no server source maps (Turbopack
    // builds do). Vibehard remaps server V8 coverage through them and
    // fails closed without them, so force them for the server bundle.
    if (isServer) config.devtool = "source-map";
    return config;
  },
};

export default nextConfig;
