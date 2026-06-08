import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { renderReplayVideoFromManifest, type ReplayVideoManifest, type ReplayAudioKey } from "../server/replayVideo.js";

const DEFAULT_SERVER = "https://agent-chess.onrender.com";

function printUsage() {
  console.log("Usage: npm run render:remote-video -- <game-id> [output.mp4] [server-base-url]");
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function main() {
  const gameId = process.argv[2];
  const outputArg = process.argv[3];
  const serverBaseUrl = normalizeBaseUrl(process.argv[4] || DEFAULT_SERVER);

  if (!gameId) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const outputPath = resolve(outputArg || join(process.cwd(), "local-renders", `game-${gameId}.mp4`));
  const manifestUrl = `${serverBaseUrl}/api/export/${gameId}/manifest`;
  const payload = await fetchJson(manifestUrl) as { ok?: boolean; manifest?: ReplayVideoManifest; error?: string };
  if (!payload.ok || !payload.manifest) {
    throw new Error(payload.error || "Manifest response was invalid");
  }

  await mkdir(dirname(outputPath), { recursive: true });
  console.log(`Rendering game ${gameId}`);
  console.log(`Manifest: ${manifestUrl}`);
  console.log(`Output: ${outputPath}`);

  await renderReplayVideoFromManifest(payload.manifest, {
    outputPath,
    resolveAudioSource: (key: ReplayAudioKey) => payload.manifest!.audio[key].url,
  });

  const metadataPath = `${outputPath}.manifest.json`;
  await writeFile(metadataPath, JSON.stringify(payload.manifest, null, 2));
  console.log(`Done: ${outputPath}`);
  console.log(`Manifest snapshot: ${metadataPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
