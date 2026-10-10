import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Not Vite's default 5173, which is the first port every other Vite
    // project on a machine also takes. strictPort makes a clash fail loudly
    // instead of silently moving to another port, which would leave the
    // backend and the checks pointing at nothing.
    port: 5180,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, stable vendor libs into their own chunks so that
        // app-code changes don't force the browser to re-download three.js /
        // drei / fiber, and so the initial parse/eval of app code isn't
        // blocked on the whole graph.
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("three") || id.includes("@react-three/fiber")) {
              return "three";
            }
            if (id.includes("@react-three/drei")) {
              return "drei";
            }
            if (id.includes("react") || id.includes("scheduler")) {
              return "react";
            }
          }
          return undefined;
        },
      },
    },
  },
});
