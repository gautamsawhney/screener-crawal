/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true,
    // Avoid bundling undici so private fields don't get parsed by Webpack.
    serverComponentsExternalPackages: ["undici"]
  }
};

export default nextConfig;
