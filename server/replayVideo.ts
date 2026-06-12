import { writeFile, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { Chess } from "chess.js";

import { analyzeReplayGame, type MoveAnalysis } from "./engineAnalysis.js";
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
  audioKey: ReplayAudioKey;
  analysis: MoveAnalysis | null;
  statusText: string;
  overlayFrameCount: number;
}

export interface ReplayVideoManifest {
  version: 2;
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
const STATUS_FRAMES_PER_CHAR = 2.2;
const STATUS_MIN_TAIL_FRAMES = 12;

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

function isHttpSource(value: string) {
  return /^https?:\/\//i.test(value);
}

async function loadMoveSample(sampleSource: string) {
  const usePipeInput = isHttpSource(sampleSource);
  const ffmpegArgs = usePipeInput
    ? [
        "-v", "error",
        "-i", "pipe:0",
        "-ar", "48000",
        "-ac", "1",
        "-f", "wav",
        "-acodec", "pcm_s16le",
        "pipe:1",
      ]
    : [
        "-v", "error",
        "-i", sampleSource,
        "-ar", "48000",
        "-ac", "1",
        "-f", "wav",
        "-acodec", "pcm_s16le",
        "pipe:1",
      ];
  const ffmpeg = spawn("ffmpeg", ffmpegArgs);

  if (usePipeInput) {
    const response = await fetch(sampleSource);
    if (!response.ok) {
      ffmpeg.kill("SIGKILL");
      throw new Error(`Could not fetch sample ${sampleSource} (${response.status})`);
    }
    const audioBytes = Buffer.from(await response.arrayBuffer());
    ffmpeg.stdin.write(audioBytes);
    ffmpeg.stdin.end();
  }

  const samples = parseMonoWavPcm16(await collectProcessStdout(ffmpeg, "ffmpeg sample decode"));
  const durationSeconds = samples.length / 48_000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not decode sample duration for ${sampleSource}`);
  }

  return {
    durationSeconds,
    samples,
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

function statusCharacterCount(text: string) {
  return Math.max(1, text.trim().length);
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

export async function buildReplayVideoManifest(gameData: ReplayVideoGameData, origin: string): Promise<ReplayVideoManifest> {
  const chess = new Chess();
  const analysis = await analyzeReplayGame(gameData);
  const moves: ReplayVideoManifestMove[] = [];

  for (const [index, move] of gameData.history.entries()) {
    const previousFen = chess.fen();
    chess.move(move.uci);
    const audioKey = getAudioKeyForMove(move);
    const moveAnalysis = analysis.moves[index] ?? null;
    moves.push({
      move,
      previousFen,
      fen: chess.fen(),
      audioKey,
      analysis: moveAnalysis,
      statusText: moveAnalysis?.display || "Unknown",
      overlayFrameCount: 0,
    });
  }

  return {
    version: 2,
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

function withComputedOverlayFrames(
  manifest: ReplayVideoManifest,
  samplesByKey: Record<ReplayAudioKey, ReplaySoundSample>,
): ReplayVideoManifest {
  return {
    ...manifest,
    moves: manifest.moves.map((entry) => {
      const sample = samplesByKey[entry.audioKey];
      const moveAnimationFrames = Math.max(1, Math.round(sample.durationSeconds * manifest.exportFps));
      const charCount = statusCharacterCount(entry.statusText);
      const readingFrames = Math.ceil(charCount * STATUS_FRAMES_PER_CHAR);
      const overlayFrameCount = Math.max(
        moveAnimationFrames + STATUS_MIN_TAIL_FRAMES,
        readingFrames,
      );
      return { ...entry, overlayFrameCount };
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
  const manifest = withComputedOverlayFrames(manifestInput, samplesByKey);
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
    await writeFrame(generateFrameSvg({
      fen: chess.fen(),
      agents: manifest.agents,
    }));
    totalFrameCount += 1;
  }

  for (const entry of manifest.moves) {
    const sample = samplesByKey[entry.audioKey];
    const cueTimeSeconds = totalFrameCount / manifest.exportFps;
    audioCues.push({ timeSeconds: cueTimeSeconds, sample: sample.samples, gain: 0.96 });
    chess.move(entry.move.uci);

    const moveAnimationFrames = Math.max(1, Math.round(sample.durationSeconds * manifest.exportFps));

    for (let frameIndex = 0; frameIndex < entry.overlayFrameCount; frameIndex++) {
      const progress = Math.min(1, (frameIndex + 1) / moveAnimationFrames);
      await writeFrame(generateFrameSvg({
        fen: entry.fen,
        previousFen: entry.previousFen,
        lastMove: entry.move,
        moveProgress: progress,
        agents: manifest.agents,
        statusOverlay: {
          label: entry.analysis?.label || "unknown",
          text: entry.statusText,
          popProgress: Math.min(1, (frameIndex + 1) / 3),
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
        agents: manifest.agents,
        statusOverlay: {
          label: entry.analysis?.label || "unknown",
          text: entry.statusText,
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
