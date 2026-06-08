import { writeFile, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { Chess } from "chess.js";

import { generateFrameSvg } from "./svgRenderer.js";

export type ReplayAudioKey =
  | "move-self"
  | "move-opponent"
  | "capture"
  | "move-check"
  | "castle"
  | "game-end"
  | "promote";

export interface ReplayHistoryMove {
  color: "white" | "black";
  san: string;
  uci: string;
  from: string;
  to: string;
  reason: string;
  at: string;
}

export interface ReplayVideoManifestMove {
  move: ReplayHistoryMove;
  previousFen: string;
  fen: string;
  speaker: string;
  audioKey: ReplayAudioKey;
  commentaryFrameCount: number;
}

export interface ReplayVideoManifest {
  version: 1;
  gameId: string;
  exportFps: number;
  initialHoldFrames: number;
  endHoldFrames: number;
  audio: Record<ReplayAudioKey, { url: string }>;
  agents: {
    white: { name: string | null };
    black: { name: string | null };
  };
  moves: ReplayVideoManifestMove[];
}

interface ReplayVideoGameData {
  gameId: string;
  agents?: {
    white?: { name?: string | null } | null;
    black?: { name?: string | null } | null;
  };
  history: ReplayHistoryMove[];
}

const EXPORT_FPS = 24;
const INITIAL_HOLD_FRAMES = Math.floor(EXPORT_FPS * 0.75);
const END_HOLD_FRAMES = 8;

const AUDIO_FILENAME_BY_KEY: Record<ReplayAudioKey, string> = {
  "move-self": "move-self.mp3",
  "move-opponent": "move-opponent.mp3",
  "capture": "capture.mp3",
  "move-check": "move-check.mp3",
  "castle": "castle.mp3",
  "game-end": "game-end.mp3",
  "promote": "promote.mp3",
};

function waitForProcess(child: ReturnType<typeof spawn>, label: string) {
  return new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exit code ${code}`));
    });
    child.on("error", reject);
  });
}

function collectProcessStdout(child: ReturnType<typeof spawn>, label: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    if (!child.stdout) {
      reject(new Error(`${label} has no stdout stream`));
      return;
    }
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${label} exit code ${code}`));
    });
    child.on("error", reject);
  });
}

function encodePcm16Sample(value: number) {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function isCaptureMove(move: Pick<ReplayHistoryMove, "san">) {
  return typeof move.san === "string" && move.san.includes("x");
}

function isCastleMove(move: Pick<ReplayHistoryMove, "san">) {
  return typeof move.san === "string" && (move.san.includes("O-O") || move.san.includes("0-0"));
}

function isPromotionMove(move: Pick<ReplayHistoryMove, "san" | "uci">) {
  return typeof move.uci === "string" ? move.uci.length === 5 : typeof move.san === "string" && move.san.includes("=");
}

function isCheckmateMove(move: Pick<ReplayHistoryMove, "san">) {
  return typeof move.san === "string" && move.san.includes("#");
}

function isCheckMove(move: Pick<ReplayHistoryMove, "san">) {
  return typeof move.san === "string" && move.san.includes("+");
}

function parseMonoWavPcm16(buffer: Buffer) {
  const dataOffset = buffer.indexOf("data");
  if (dataOffset < 0) throw new Error("WAV data chunk not found");
  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  const pcmStart = dataOffset + 8;
  const pcmEnd = Math.min(buffer.length, pcmStart + dataSize);
  const sampleCount = Math.floor((pcmEnd - pcmStart) / 2);
  const samples = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(pcmStart + i * 2) / 0x8000;
  }
  return samples;
}

async function loadMoveSample(sampleSource: string) {
  const ffprobe = spawn("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    sampleSource,
  ]);
  const durationText = (await collectProcessStdout(ffprobe, "ffprobe sample duration")).toString("utf8").trim();
  const durationSeconds = Number.parseFloat(durationText);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not read sample duration for ${sampleSource}`);
  }

  const ffmpeg = spawn("ffmpeg", [
    "-v", "error",
    "-i", sampleSource,
    "-ar", "48000",
    "-ac", "1",
    "-f", "wav",
    "-acodec", "pcm_s16le",
    "pipe:1",
  ]);

  return {
    durationSeconds,
    samples: parseMonoWavPcm16(await collectProcessStdout(ffmpeg, "ffmpeg sample decode")),
  };
}

function buildLayeredAudioTrack(
  durationSeconds: number,
  cues: Array<{ timeSeconds: number; sample: Float32Array; gain?: number }>,
) {
  const sampleRate = 48_000;
  const totalSamples = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const mono = new Float32Array(totalSamples);

  for (const cue of cues) {
    const startSample = Math.max(0, Math.floor(cue.timeSeconds * sampleRate));
    const gain = cue.gain ?? 1;
    for (let i = 0; i < cue.sample.length && startSample + i < totalSamples; i++) {
      mono[startSample + i] += cue.sample[i] * gain;
    }
  }

  const bytesPerSample = 2;
  const channels = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = totalSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    const sample = encodePcm16Sample(mono[i]);
    buffer.writeInt16LE(sample, offset);
    buffer.writeInt16LE(sample, offset + 2);
    offset += 4;
  }

  return buffer;
}

function getAudioKeyForMove(move: ReplayHistoryMove): ReplayAudioKey {
  if (isCheckmateMove(move)) return "game-end";
  if (isPromotionMove(move)) return "promote";
  if (isCastleMove(move)) return "castle";
  if (isCheckMove(move)) return "move-check";
  if (isCaptureMove(move)) return "capture";
  return move.color === "black" ? "move-opponent" : "move-self";
}

function getSpeakerName(gameData: ReplayVideoGameData, color: "white" | "black") {
  const fallback = color === "white" ? "White" : "Black";
  return gameData.agents?.[color]?.name || fallback;
}

export function getReplayAudioUrls(origin: string) {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  return Object.fromEntries(
    Object.entries(AUDIO_FILENAME_BY_KEY).map(([key, filename]) => [
      key,
      { url: `${normalizedOrigin}/api/audio/${filename}` },
    ]),
  ) as ReplayVideoManifest["audio"];
}

export function buildReplayVideoManifest(gameData: ReplayVideoGameData, origin: string): ReplayVideoManifest {
  const chess = new Chess();
  const moves: ReplayVideoManifestMove[] = [];

  for (const move of gameData.history) {
    const previousFen = chess.fen();
    chess.move(move.uci);
    const audioKey = getAudioKeyForMove(move);
    moves.push({
      move,
      previousFen,
      fen: chess.fen(),
      speaker: getSpeakerName(gameData, move.color),
      audioKey,
      commentaryFrameCount: 0,
    });
  }

  return {
    version: 1,
    gameId: gameData.gameId,
    exportFps: EXPORT_FPS,
    initialHoldFrames: INITIAL_HOLD_FRAMES,
    endHoldFrames: END_HOLD_FRAMES,
    audio: getReplayAudioUrls(origin),
    agents: {
      white: { name: gameData.agents?.white?.name || null },
      black: { name: gameData.agents?.black?.name || null },
    },
    moves,
  };
}

interface ReplaySoundSample {
  durationSeconds: number;
  samples: Float32Array;
}

async function loadManifestSamples(
  manifest: ReplayVideoManifest,
  resolveAudioSource: (key: ReplayAudioKey) => string,
) {
  const entries = await Promise.all(
    (Object.keys(manifest.audio) as ReplayAudioKey[]).map(async (key) => [key, await loadMoveSample(resolveAudioSource(key))] as const),
  );
  return Object.fromEntries(entries) as Record<ReplayAudioKey, ReplaySoundSample>;
}

function withComputedCommentaryFrames(
  manifest: ReplayVideoManifest,
  samplesByKey: Record<ReplayAudioKey, ReplaySoundSample>,
): ReplayVideoManifest {
  return {
    ...manifest,
    moves: manifest.moves.map((entry) => {
      const sample = samplesByKey[entry.audioKey];
      const moveAnimationFrames = Math.max(1, Math.round(sample.durationSeconds * manifest.exportFps));
      const minCommentaryFrames = moveAnimationFrames + 4;
      const maxCommentaryFrames = moveAnimationFrames + 20;
      const wordCount = entry.move.reason.trim().split(/\s+/).filter(Boolean).length;
      const commentaryFrameCount = Math.max(
        minCommentaryFrames,
        Math.min(maxCommentaryFrames, moveAnimationFrames + wordCount * 2),
      );
      return { ...entry, commentaryFrameCount };
    }),
  };
}

export async function renderReplayVideoFromManifest(
  manifestInput: ReplayVideoManifest,
  options: {
    outputPath: string;
    resolveAudioSource: (key: ReplayAudioKey) => string;
  },
) {
  const samplesByKey = await loadManifestSamples(manifestInput, options.resolveAudioSource);
  const manifest = withComputedCommentaryFrames(manifestInput, samplesByKey);
  const outputDir = dirname(options.outputPath);
  mkdirSync(outputDir, { recursive: true });

  const videoOnlyPath = `${options.outputPath}.video.mp4`;
  const audioTrackPath = `${options.outputPath}.audio.wav`;
  const muxedTempPath = `${options.outputPath}.muxed.mp4`;
  const ffmpeg = spawn("ffmpeg", [
    "-y",
    "-f", "image2pipe",
    "-vcodec", "png",
    "-r", String(manifest.exportFps),
    "-i", "-",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    videoOnlyPath,
  ]);

  const audioCues: Array<{ timeSeconds: number; sample: Float32Array; gain?: number }> = [];
  let totalFrameCount = 0;

  const writeFrame = async (svg: string) => {
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
    ffmpeg.stdin.write(pngBuffer);
  };

  const chess = new Chess();
  for (let i = 0; i < manifest.initialHoldFrames; i++) {
    await writeFrame(generateFrameSvg({ fen: chess.fen() }));
    totalFrameCount += 1;
  }

  for (const entry of manifest.moves) {
    const sample = samplesByKey[entry.audioKey];
    const cueTimeSeconds = totalFrameCount / manifest.exportFps;
    audioCues.push({ timeSeconds: cueTimeSeconds, sample: sample.samples, gain: 0.96 });
    chess.move(entry.move.uci);

    const wordCount = entry.move.reason.trim().split(/\s+/).filter(Boolean).length;
    const moveAnimationFrames = Math.max(1, Math.round(sample.durationSeconds * manifest.exportFps));

    for (let frameIndex = 0; frameIndex < entry.commentaryFrameCount; frameIndex++) {
      const progress = Math.min(1, (frameIndex + 1) / moveAnimationFrames);
      const wordsShown = Math.min(
        wordCount,
        Math.max(1, Math.floor(((frameIndex + 1) / entry.commentaryFrameCount) * wordCount)),
      );
      await writeFrame(generateFrameSvg({
        fen: entry.fen,
        previousFen: entry.previousFen,
        lastMove: entry.move,
        moveProgress: progress,
        commentary: {
          color: entry.move.color,
          san: entry.move.san,
          speaker: entry.speaker,
          text: entry.move.reason,
          revealedWords: wordsShown,
          popProgress: Math.min(1, (frameIndex + 1) / 2),
        },
      }));
      totalFrameCount += 1;
    }

    for (let hold = 0; hold < manifest.endHoldFrames; hold++) {
      await writeFrame(generateFrameSvg({
        fen: entry.fen,
        previousFen: entry.previousFen,
        lastMove: entry.move,
        moveProgress: 1,
        commentary: {
          color: entry.move.color,
          san: entry.move.san,
          speaker: entry.speaker,
          text: entry.move.reason,
          revealedWords: wordCount,
          popProgress: 1,
        },
      }));
      totalFrameCount += 1;
    }
  }

  ffmpeg.stdin.end();
  await waitForProcess(ffmpeg, "ffmpeg video export");

  const audioDurationSeconds = totalFrameCount / manifest.exportFps;
  const audioTrack = buildLayeredAudioTrack(audioDurationSeconds, audioCues);
  await writeFile(audioTrackPath, audioTrack);

  const muxFfmpeg = spawn("ffmpeg", [
    "-y",
    "-i", videoOnlyPath,
    "-i", audioTrackPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    muxedTempPath,
  ]);
  await waitForProcess(muxFfmpeg, "ffmpeg audio mux");

  await rename(muxedTempPath, options.outputPath);
  await Promise.allSettled([
    rm(videoOnlyPath, { force: true }),
    rm(audioTrackPath, { force: true }),
  ]);

  return manifest;
}

export function defaultServerAudioSource(audioDir: string, key: ReplayAudioKey) {
  return join(audioDir, AUDIO_FILENAME_BY_KEY[key]);
}
