import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "browser.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:43287", browserName: "chromium" },
  webServer: {
    command: "bun server.tsx",
    url: "http://127.0.0.1:43287",
    reuseExistingServer: false,
  },
});
