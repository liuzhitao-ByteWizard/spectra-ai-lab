import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const clientDirectory = resolve(projectRoot, "dist", "client");
const serverDirectory = resolve(projectRoot, "dist", "server");
const pagesDirectory = resolve(projectRoot, "dist-pages");
const pagesWorkerEntry = resolve(projectRoot, "scripts", "pages-worker-entry.mjs");
const generatedDeploymentConfig = resolve(projectRoot, ".wrangler", "deploy", "config.json");

await Promise.all([
  access(clientDirectory),
  access(serverDirectory),
]);

await rm(pagesDirectory, { recursive: true, force: true });
await mkdir(pagesDirectory, { recursive: true });

// Pages advanced mode needs a self-contained Module Worker at the build output
// root, while Vinext emits its public assets and Worker module tree separately.
await cp(clientDirectory, pagesDirectory, { recursive: true });
await build({
  entryPoints: [pagesWorkerEntry],
  outfile: resolve(pagesDirectory, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["cloudflare:workers"],
  logLevel: "info",
});

// Vinext leaves a local Worker deployment pointer behind after building. Pages
// deployments must load this project's Pages configuration instead.
await rm(generatedDeploymentConfig, { force: true });

console.log(`Cloudflare Pages output prepared at ${pagesDirectory}`);
