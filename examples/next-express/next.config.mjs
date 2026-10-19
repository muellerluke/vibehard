/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vibehard remaps browser coverage through source maps; without this,
  // the production build's client chunks have none and verify fails closed.
  productionBrowserSourceMaps: true,
};

export default nextConfig;
