import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: Number(process.env.PAYMVC_DEV_PORT ?? 5189),
    strictPort: true,
    watch: { ignored: ["**/.local/**", "**/target/**"] },
    // The local node sends no CORS headers. The local deployment record
    // (`npm run local`) reads it through this same-origin path.
    proxy: {
      "/thruput-rpc": {
        target: "http://127.0.0.1:9545",
        rewrite: (path) => path.replace(/^\/thruput-rpc/, ""),
      },
    },
    // .local holds deployment and test signing keys. Never serve it.
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/.local/**",
        "**/target/**",
      ],
    },
  },
  preview: { port: 5189, strictPort: true },
});
