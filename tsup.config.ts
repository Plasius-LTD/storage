import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/immutable-assets.ts"],
  dts: true,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  target: "es2022",
});
