import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const parsePort = (value: string | undefined, fallback: number) => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
};

const devServerPort = parsePort(process.env.ELECTRON_INTERNAL_PORT, 3210);
const apiServerPort = parsePort(process.env.ELECTRON_API_PORT, 3211);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: devServerPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiServerPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
