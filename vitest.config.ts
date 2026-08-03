import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["electron/**/*.test.js", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "release/**", "build/**"],
  },
});
