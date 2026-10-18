import { defineConfig } from "vite";

/* StreamDrop has no backend: the app is static files, and transfers happen device-to-device. */
export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
  },
});
