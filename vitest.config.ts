import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) }, dedupe: ["react", "react-dom"] },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], restoreMocks: true, setupFiles: ["tests/setup.ts"], maxWorkers: 2, testTimeout: 15_000 },
});
