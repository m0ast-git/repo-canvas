import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const cleanGeneratedAssets = {
  name: "clean-generated-assets",
  buildStart() {
    fs.rmSync(path.resolve("public/assets"), { recursive: true, force: true });
  },
};

export default defineConfig({
  root: "client",
  plugins: [cleanGeneratedAssets, react()],
  build: {
    outDir: "../public",
    emptyOutDir: false,
    sourcemap: false,
    license: { fileName: "licenses/bundled-dependencies.md" },
    target: "es2022",
    assetsDir: "assets",
    rolldownOptions: {
      input: {
        app: path.resolve("client/index.html"),
        designSystem: path.resolve("client/design-system.html"),
      },
    },
  },
});
