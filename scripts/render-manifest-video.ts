import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { defaultServerAudioSource, renderReplayVideoFromManifest, type ReplayAudioKey, type ReplayVideoManifest } from "../server/replayVideo.js";

async function main() {
  const manifestArg = process.argv[2];
  const outputArg = process.argv[3];

  if (!manifestArg) {
    console.log("Usage: node --import tsx scripts/render-manifest-video.ts <manifest.json> [output.mp4]");
    process.exitCode = 1;
    return;
  }

  const manifestPath = resolve(manifestArg);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReplayVideoManifest;
  const outputPath = resolve(outputArg || join(process.cwd(), "local-renders", `game-${manifest.gameId}.rerender.mp4`));
  const audioDir = join(process.cwd(), "server", "assets", "audio");

  console.log(`Rendering manifest ${manifestPath}`);
  console.log(`Output: ${outputPath}`);

  await renderReplayVideoFromManifest(manifest, {
    outputPath,
    resolveAudioSource: (key: ReplayAudioKey) => defaultServerAudioSource(audioDir, key),
  });

  console.log(`Done: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
