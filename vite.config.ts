import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal Vite config: React plugin only. No additional plugins/deps
// so the build surface stays small and predictable.
export default defineConfig({
  plugins: [react()],
});
