import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { networkNamed, networks } from "./src/networks/index.ts";

const network = networkNamed(process.env.PAYMVC_NETWORK);
const directory = resolve(".");

export default defineConfig({
  publicDir: resolve(directory, "public"),
  define: {
    "import.meta.env.VITE_NETWORK": JSON.stringify(
      process.env.PAYMVC_NETWORK ?? "ethereum",
    ),
  },
  build: {
    outDir: resolve(directory, "dist"),
    emptyOutDir: true,
    copyPublicDir: false,
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "public-assets",
      async generateBundle() {
        // Publish only intended assets; public/local.json belongs to Anvil development.
        for (const file of [
          "theme.js",
          "favicon.svg",
          "favicon.ico",
          "apple-touch-icon.png",
        ])
          this.emitFile({
            type: "asset",
            fileName: file,
            source: await readFile(resolve(directory, "public", file)),
          });
        for (const item of Object.values(networks)) {
          this.emitFile({
            type: "asset",
            fileName: `deployments/${item.deployment}`,
            source: await readFile(
              resolve(directory, "deployments", item.deployment),
              "utf8",
            ),
          });
        }
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: network.port,
    strictPort: true,
    watch: { ignored: ["**/.local/**", "**/out/**", "**/cache/**"] },
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.local/**"],
    },
  },
});
