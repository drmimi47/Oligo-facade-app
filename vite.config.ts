import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal Vite config: React plugin only. No additional plugins/deps
// so the build surface stays small and predictable.
export default defineConfig({
  plugins: [react()],
  // Served behind the VM's nginx (TLS). `ALLOWED_HOSTS` is a comma-separated list of
  // public hostnames; if unset, allow any host (the container only binds to localhost).
  server: {
    host: true,
    allowedHosts: process.env.ALLOWED_HOSTS
      ? process.env.ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
      : true,
    hmr: { protocol: "wss", clientPort: 443 },
  },
});
