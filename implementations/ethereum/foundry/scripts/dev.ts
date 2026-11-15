import { createServer } from "vite";
import { networkId } from "./network";

process.env.PAYMVC_NETWORK = networkId;
const portIndex = process.argv.indexOf("--port");
const port = portIndex < 0 ? undefined : Number(process.argv[portIndex + 1]);
if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
  throw new Error("--port requires a valid TCP port.");
const server = await createServer({
  server: { host: "127.0.0.1", ...(port ? { port } : {}) },
});
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
