import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = process.argv[2];
const buildId = process.argv[3];
if (!outputDirectory || !buildId) {
  throw new Error("Usage: node patch-web-build.mjs <output directory> <build ID>");
}

const version = encodeURIComponent(buildId);
const versioned = (asset) => `${asset}?v=${version}`;

const indexPath = path.join(outputDirectory, "index.html");
let html = await readFile(indexPath, "utf8");
const headAssets = [
  ["favicon.ico", `    <link rel="shortcut icon" type="image/x-icon" href="${versioned("favicon.ico")}">`],
  ["consolewrapper.js", `    <script src="${versioned("consolewrapper.js")}"></script>`],
  ["webdb.js", `    <script src="${versioned("webdb.js")}"></script>`],
  ["persistence.js", `    <script src="${versioned("persistence.js")}"></script>`],
  ["client-config.js", `    <script src="${versioned("client-config.js")}"></script>`],
  ["websocket-bridge.js", `    <script src="${versioned("websocket-bridge.js")}"></script>`],
  [
    "techmino-cache-refresh",
    '    <script id="techmino-cache-refresh">window.addEventListener("pageshow",function(event){if(event.persisted)window.location.reload();});</script>',
  ],
];

for (const [marker, element] of headAssets) {
  if (!html.includes(marker)) html = html.replace("</head>", `${element}\n  </head>`);
}

const versionedAssets = [
  "favicon.ico",
  "consolewrapper.js",
  "webdb.js",
  "persistence.js",
  "client-config.js",
  "websocket-bridge.js",
  "theme/love.css",
  "game.js",
  "love.js",
];

for (const asset of versionedAssets) {
  const escapedAsset = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assetPattern = new RegExp(`(["'])${escapedAsset}(?:\\?[^"']*)?\\1`, "g");
  html = html.replace(assetPattern, `"${versioned(asset)}"`);
}

const defaultDependencyStatus = "Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');";
const downloadAwareStatus = `var packageProgress = this.dataFileDownloads && this.dataFileDownloads['game.data'];
          if (left && packageProgress && this.finishedDataFileDownloads < this.expectedDataFileDownloads) {
            Module.setStatus('Downloading data... (' + packageProgress.loaded + '/' + packageProgress.total + ')');
          } else {
            ${defaultDependencyStatus}
          }`;
if (!html.includes("var packageProgress = this.dataFileDownloads")) {
  if (!html.includes(defaultDependencyStatus)) {
    throw new Error("Could not find the Love.js dependency status handler in index.html");
  }
  html = html.replace(defaultDependencyStatus, downloadAwareStatus);
}

html = html.replace('"32, 37, 38, 39, 40"', '"37, 38, 39, 40"');
await writeFile(indexPath, html, "utf8");
