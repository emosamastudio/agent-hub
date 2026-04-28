import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendTarget = env.AGENT_HUB_BACKEND_URL || "http://127.0.0.1:8788";

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target: backendTarget,
          changeOrigin: true,
          ws: true,
        },
        "/health": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/ws": {
          target: backendTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
