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
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name: "mermaid",
              test: /node_modules[\\/](?:@streamdown[\\/]mermaid|mermaid)[\\/]/,
              priority: 20,
            },
            {
              name: "streamdown",
              test: /node_modules[\\/](?:streamdown|@streamdown)[\\/]/,
              priority: 10,
            },
            {
              name: "xterm",
              test: /node_modules[\\/]@xterm[\\/]/,
              priority: 10,
            },
            {
              name: "codemirror",
              test: /node_modules[\\/](?:@codemirror|@uiw[\\/]react-codemirror)[\\/]/,
              priority: 10,
            },
            {
              name: "lucide",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 5,
            },
          ],
        },
      },
    },
  },
});
