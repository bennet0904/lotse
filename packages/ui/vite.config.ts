import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During development the UI runs on its own port and forwards API calls to the builder server.
const server = process.env.LOTSE_SERVER ?? "http://127.0.0.1:4780";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 4781,
    proxy: { "/api": { target: server, ws: true } },
  },
});
