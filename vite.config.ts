import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Bind IPv4 explicitly. On Windows, Vite's default `localhost` often listens on
    // [::1] only while Tauri/WebView2 may resolve `localhost` to 127.0.0.1 → blank white window.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});