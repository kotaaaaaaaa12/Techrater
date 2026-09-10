import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = process.argv[2];
const buildId = process.argv[3];
if (!outputDirectory || !buildId) {
  throw new Error("Usage: node split-game-data.mjs <output directory> <build ID>");
}

const chunkSize = 20 * 1024 * 1024;
const dataPath = path.join(outputDirectory, "game.data");
const scriptPath = path.join(outputDirectory, "game.js");
const dataSize = (await stat(dataPath)).size;

if (dataSize > chunkSize) {
  const partNames = [];
  const source = await open(dataPath, "r");

  try {
    let offset = 0;
    let index = 0;

    while (offset < dataSize) {
      const length = Math.min(chunkSize, dataSize - offset);
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;

      while (filled < length) {
        const { bytesRead } = await source.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) throw new Error("Unexpected end of game.data");
        filled += bytesRead;
      }

      const partName = `game.data.part${String(index).padStart(3, "0")}`;
      await writeFile(path.join(outputDirectory, partName), buffer);
      partNames.push(partName);
      offset += length;
      index += 1;
    }
  } finally {
    await source.close();
  }

  let script = await readFile(scriptPath, "utf8");
  const functionStart = "    function fetchRemotePackage(packageName, packageSize, callback, errback) {";
  const functionEnd = "\n    function handleError(error) {";
  const startIndex = script.indexOf(functionStart);
  const endIndex = script.indexOf(functionEnd, startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error("Could not find the Love.js data loader in game.js");
  }

  const replacement = `    function fetchRemotePackage(packageName, packageSize, callback, errback) {
      var partNames = ${JSON.stringify(partNames)};
      var packageVersion = ${JSON.stringify(buildId)};

      (async function() {
        var packageBytes = new Uint8Array(packageSize);
        var loaded = 0;
        var packageUrl = new URL(packageName, globalThis.location.href);

        function updateProgress() {
          if (!Module.dataFileDownloads) Module.dataFileDownloads = {};
          Module.dataFileDownloads[packageName] = { loaded: loaded, total: packageSize };
          if (Module['setStatus']) Module['setStatus']('Downloading data... (' + loaded + '/' + packageSize + ')');
        }

        updateProgress();
        for (var index = 0; index < partNames.length; index++) {
          var partUrl = new URL(partNames[index], packageUrl);
          partUrl.searchParams.set('v', packageVersion);
          var response = await fetch(partUrl.href, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(response.status + ' : ' + partUrl.href);

          if (response.body && typeof response.body.getReader === 'function') {
            var reader = response.body.getReader();
            while (true) {
              var result = await reader.read();
              if (result.done) break;
              if (loaded + result.value.byteLength > packageSize) throw new Error('Downloaded data is larger than expected');
              packageBytes.set(result.value, loaded);
              loaded += result.value.byteLength;
              updateProgress();
            }
          } else {
            var partBytes = new Uint8Array(await response.arrayBuffer());
            if (loaded + partBytes.byteLength > packageSize) throw new Error('Downloaded data is larger than expected');
            packageBytes.set(partBytes, loaded);
            loaded += partBytes.byteLength;
            updateProgress();
          }
        }

        if (loaded !== packageSize) throw new Error('Downloaded data size does not match game.data');
        callback(packageBytes.buffer);
      })().catch(function(error) {
        if (Module['setStatus']) Module['setStatus']('Download failed. Reload the page.');
        errback(error);
      });
    };
`;

  script = `${script.slice(0, startIndex)}${replacement}${script.slice(endIndex)}`;

  // The generated loader waits for the entire package to be copied into
  // IndexedDB before starting the game. Large writes can stall on Safari.
  // Versioned chunk URLs already provide safe browser caching, so load the
  // package directly without blocking startup on EM_PRELOAD_CACHE.
  const databaseStart = script.indexOf("      openDatabase(");
  const statusStart = script.indexOf(
    "      if (Module['setStatus']) Module['setStatus']('Downloading...');",
    databaseStart,
  );
  if (databaseStart === -1 || statusStart === -1) {
    throw new Error("Could not find the Love.js IndexedDB preload block in game.js");
  }
  const directLoader = `      Module.preloadResults[PACKAGE_NAME] = {fromCache: false};
      console.info('loading ' + PACKAGE_NAME + ' from versioned chunks');
      fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE, processPackageData, handleError);

`;
  script = `${script.slice(0, databaseStart)}${directLoader}${script.slice(statusStart)}`;

  await writeFile(scriptPath, script, "utf8");
  await rm(dataPath);
}
