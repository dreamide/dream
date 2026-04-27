import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./electron/drizzle",
  schema: "./electron/db/schema.ts",
});
