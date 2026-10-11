import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/actions": "http://localhost:3000", "/files": "http://localhost:3000", "/health": "http://localhost:3000" },
  },
});
