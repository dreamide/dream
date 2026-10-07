import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // A launched agent can inherit the live database path. Keep it defined but
    // empty so dotenv cannot restore it; host tests configure their temp paths.
    env: { DREAM_DB_PATH: "" },
    environment: "node",
    include: ["electron/**/*.test.js", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "release/**", "build/**"],
  },
});
