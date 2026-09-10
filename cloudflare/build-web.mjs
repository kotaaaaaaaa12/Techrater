import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");
const serverUrl = normalizeServerUrl(process.env.TECHMINO_SERVER_URL);
const buildId = normalizeBuildId(process.env.CF_PAGES_COMMIT_SHA || randomUUID());
const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "techmino-web-"));

const sourceDirectories = ["media", "parts", "Zframework"];
const sourceFiles = ["conf.lua", "main.lua", "version.lua", "legals.md", "license.txt"];
const apiPlayerBaseUrl = "https://raw.githubusercontent.com/MrcSnm/Love.js-Api-Player/refs/heads/master";

function normalizeServerUrl(value) {
  if (!value) throw new Error("TECHMINO_SERVER_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("TECHMINO_SERVER_URL must use HTTP or HTTPS");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TECHMINO_SERVER_URL must contain only the origin");
  }
  return url.origin;
}

function normalizeBuildId(value) {
  const build = String(value).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  if (!build) throw new Error("Could not create a build ID");
  return build;
}

function run(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function download(name) {
  const response = await fetch(`${apiPlayerBaseUrl}/${name}`);
  if (!response.ok) throw new Error(`Could not download ${name} (${response.status})`);
  await writeFile(path.join(outputDirectory, name), new Uint8Array(await response.arrayBuffer()));
}

try {
  for (const directory of sourceDirectories) {
    await cp(path.join(projectRoot, directory), path.join(stagingDirectory, directory), { recursive: true });
  }
  for (const file of sourceFiles) {
    await cp(path.join(projectRoot, file), path.join(stagingDirectory, file));
  }

  await run(process.execPath, [path.join(projectRoot, "cloudflare/patch-techmino-web.mjs"), stagingDirectory]);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  await run(process.execPath, [
    path.join(projectRoot, "node_modules/love.js/index.js"),
    stagingDirectory,
    outputDirectory,
    "-t", "Techmino",
    "-m", "128000000",
    "-c",
  ]);

  await cp(path.join(projectRoot, ".github/build/web/release"), outputDirectory, { recursive: true });
  await Promise.all(["consolewrapper.js", "globalizeFS.js", "webdb.js"].map(download));
  await cp(path.join(projectRoot, "cloudflare/persistence.js"), path.join(outputDirectory, "persistence.js"));
  await cp(path.join(projectRoot, "cloudflare/websocket-bridge.js"), path.join(outputDirectory, "websocket-bridge.js"));
  await writeFile(
    path.join(outputDirectory, "client-config.js"),
    [
      `globalThis.TECHMINO_SERVER_URL = ${JSON.stringify(serverUrl)};`,
      `globalThis.TECHMINO_BUILD_ID = ${JSON.stringify(buildId)};`,
      "",
    ].join("\n"),
    "utf8",
  );

  await run(process.execPath, [path.join(projectRoot, "cloudflare/split-game-data.mjs"), outputDirectory, buildId]);
  await run(process.execPath, [path.join(projectRoot, "cloudflare/patch-web-build.mjs"), outputDirectory, buildId]);
  await run(process.execPath, [path.join(outputDirectory, "globalizeFS.js")], { cwd: outputDirectory });
  await rm(path.join(outputDirectory, "globalizeFS.js"));

  const html = await readFile(path.join(outputDirectory, "index.html"), "utf8");
  if (/\p{Script=Han}/u.test(html)) throw new Error("Generated index.html contains Han characters");

  await writeFile(path.join(outputDirectory, "_headers"), [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "/",
    "  Cache-Control: no-cache, max-age=0, must-revalidate",
    "/index.html",
    "  Cache-Control: no-cache, max-age=0, must-revalidate",
    "/game.data.part*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n"), "utf8");
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
