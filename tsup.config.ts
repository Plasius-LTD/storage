import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/immutable-assets.ts",
    "src/immutable-json-packets.ts",
  ],
  dts: true,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  target: "es2022",
});
