import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { agentCoreProxy } from "./agentcore-proxy.js";

export default defineConfig({
  plugins: [react(), agentCoreProxy()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
