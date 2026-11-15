import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => ({
  define: {
    "process.env": JSON.stringify({
      NODE_ENV: mode === "production" ? "production" : "development",
    }),
  },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5175,
    strictPort: true,
    watch: { ignored: ["**/.local/**", "**/target/**", "**/.anchor/**"] },
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
}));
