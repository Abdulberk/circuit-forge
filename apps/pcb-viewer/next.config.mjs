/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // r3f + three are ESM; let Next transpile them cleanly
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing'],
};
export default nextConfig;
