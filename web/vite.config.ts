import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the same build run on GitHub Pages (/<repo>/) or any host.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: { port: 5173 },
});
