import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const port = Number(process.env.BETTERCOMMS_WEB_PORT ?? 5173);
const apiTarget = process.env.BETTERCOMMS_API_TARGET ?? "http://127.0.0.1:8080";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: ["@base-ui/react/menu", "react-dom/client"],
  },
  server: {
    port,
    strictPort: true,
    proxy: { "/api": { target: apiTarget, ws: true } },
  },
});
