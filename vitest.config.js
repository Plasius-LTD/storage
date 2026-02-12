import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.tests.ts"],
    passWithNoTests: true,
    coverage: {
      reporter: ["text", "json", "html"], // Output formats
      exclude: ["**/node_modules/**", "dist", "**/types/**"],
    },
  },
});
