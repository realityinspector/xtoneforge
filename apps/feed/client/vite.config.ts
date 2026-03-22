import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
      "/screenshots": "http://localhost:8080",
    },
  },
  build: {
    // Output feed client build to packages/smithy/feed-web for integrated serving
    outDir: resolve(__dirname, "../../../packages/smithy/feed-web"),
    emptyOutDir: true,
  },
});
