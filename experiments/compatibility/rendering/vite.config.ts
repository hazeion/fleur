import { defineConfig } from "vite";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: {
    sourcemap: true,
    manifest: true,
    rollupOptions: { input: "client.tsx", output: { entryFileNames: "client.js" } },
  },
});
