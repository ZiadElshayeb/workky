import { defineConfig } from "vite";

export default defineConfig({
  preview: {
    allowedHosts: true,
  },
  server: {
    // Proxy /api calls to the backend during development
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});
