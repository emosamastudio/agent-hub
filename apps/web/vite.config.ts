import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.AGENT_HUB_API_TARGET
  ?? `http://${process.env.AGENT_HUB_HOST ?? "127.0.0.1"}:${process.env.AGENT_HUB_PORT ?? "8788"}`;
const wsTarget = apiTarget.replace(/^http/, "ws");
const dashboardPort = Number.parseInt(process.env.AGENT_HUB_WEB_PORT ?? "5174", 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number.isFinite(dashboardPort) ? dashboardPort : 5174,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/ws": { target: wsTarget, ws: true },
    },
  },
});
