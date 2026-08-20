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
});
