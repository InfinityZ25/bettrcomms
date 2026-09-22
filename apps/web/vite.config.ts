import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
const port = Number(process.env.BETTERCOMMS_WEB_PORT ?? 5173);
const apiTarget = process.env.BETTERCOMMS_API_TARGET ?? "http://127.0.0.1:8080";
export default defineConfig({
  plugins: [react(), tailwindcss(), wails("./src/desktop/wailsbindings")],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: ["@base-ui/react/menu", "react-dom/client"],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{
            name: "wails-runtime",
            // Keep runtime initialisation and its consumers together. Splitting
            // calls.js from runtime.js creates a chunk cycle that reads
            // objectNames.Call before objectNames has been initialised.
            test: /@wailsio[\\/]runtime|wailsio_runtime_events_typed|wailsbindings.*internal[\\/]eventcreate/,
          }],
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    proxy: { "/api": { target: apiTarget, ws: true } },
  },
});
