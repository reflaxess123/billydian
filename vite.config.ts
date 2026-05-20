import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Tauri loads us from disk via the IPC scheme — keep fs traversal
    // tight so a stray symlink can't escape the project root.
    fs: { strict: true },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // WebView2 is Chromium 100+ — no polyfills needed, ship native
    // syntax all the way down. Saves a few KB of transpile fluff and
    // lets esbuild emit smaller code.
    target: "esnext",
    minify: "esbuild",
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Vendor split — lets the lazy paths (markdown / prism / d3)
        // be skipped entirely until the user opens a code file or a
        // mindmap. Initial paint loads only React + the welcome /
        // sidebar shell, not the 800 KB ball of Prism grammars and
        // KaTeX that used to gate first interactivity.
        manualChunks: {
          react: ["react", "react-dom"],
          markdown: [
            "react-markdown",
            "remark-gfm",
            "remark-math",
            "rehype-katex",
          ],
          katex: ["katex"],
          prism: [
            "prismjs",
            "react-syntax-highlighter",
            "react-simple-code-editor",
          ],
          d3: ["d3-hierarchy"],
          icons: ["lucide-react"],
        },
      },
    },
  },

  esbuild: {
    // Strip console.* and debugger statements from production builds —
    // we keep them in dev for diagnostics, but they're pure bloat in
    // the shipped binary.
    drop: ["console", "debugger"],
  },
}));
