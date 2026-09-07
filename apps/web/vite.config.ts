import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const port = Number(process.env.BETTERCOMMS_WEB_PORT ?? 5173);
const apiTarget = process.env.BETTERCOMMS_API_TARGET ?? "http://127.0.0.1:8080";
export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: { "/api": { target: apiTarget, ws: true } },
  },
});
