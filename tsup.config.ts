import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "main/index": "src/main/index.ts",
    "preload/index": "src/preload/index.ts"
  },
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  target: "node18",
  sourcemap: true,
  clean: true,
  dts: false,
  external: ["electron"]
});

