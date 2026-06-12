import { Chess } from "chess.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const initStockfish = require("stockfish");

const ENGINE_DEPTH = 12;
const ENGINE_MULTI_PV = 3;
const ENGINE_HASH_MB = 32;

const MATERIAL_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export type MoveStatusLabel =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "forced"
  | "unknown";

export interface AnalysisMoveInput {
  color: "white" | "black";
  san: string;
  uci: string;
  from: string;
  to: string;
}

export interface EnginePv {
  rank: number;
  move: string | null;
  line: string;
  cp: number | null;
  mate: number | null;
  numeric: number;
}

export interface PositionEvaluation {
  fen: string;
  turn: "white" | "black";
  depth: number;
  bestMove: string | null;
  score: {
    cp: number | null;
    mate: number | null;
    numeric: number;
    whiteAdvantage: number;
    display: string;
  } | null;
  legalMoveCount: number;
  pvs: EnginePv[];
}

export interface MoveAnalysis {
  uci: string;
  san: string;
  color: "white" | "black";
  label: MoveStatusLabel;
  display: string;
  bestMove: string | null;
  isBestMove: boolean;
  centipawnLoss: number | null;
  materialDelta: number;
  whiteAdvantageBefore: number | null;
  whiteAdvantageAfter: number | null;
}

export interface ReplayEngineAnalysis {
  engine: {
    name: string;
    depth: number;
    multiPv: number;
  };
  positions: PositionEvaluation[];
  moves: MoveAnalysis[];
}

interface RawEngineScore {
  cp: number | null;
  mate: number | null;
}

interface PendingAnalysis {
  infoByRank: Map<number, EnginePv>;
  resolve: (value: PositionEvaluation) => void;
  reject: (reason?: unknown) => void;
  fen: string;
}

interface StockfishRuntime {
  send(command: string): void;
  onLine(listener: (line: string) => void): () => void;
}

const positionCache = new Map<string, Promise<PositionEvaluation>>();
const gameCache = new Map<string, Promise<ReplayEngineAnalysis>>();

let enginePromise: Promise<StockfishRuntime> | null = null;
let engineQueue = Promise.resolve();

function numericScore(score: RawEngineScore) {
  if (typeof score.mate === "number") {
    const sign = Math.sign(score.mate) || 1;
    return sign * (100_000 - Math.min(Math.abs(score.mate), 100) * 1_000);
  }
  return score.cp ?? 0;
}

function whiteAdvantage(score: RawEngineScore, turn: "white" | "black") {
  const sign = turn === "white" ? 1 : -1;
  return numericScore(score) * sign;
}

function displayWhiteAdvantage(score: RawEngineScore, turn: "white" | "black") {
  if (typeof score.mate === "number") {
    const mateForWhite = turn === "white" ? score.mate : -score.mate;
    return `${mateForWhite > 0 ? "M" : "-M"}${Math.abs(mateForWhite)}`;
  }

  const cp = whiteAdvantage(score, turn);
  const pawns = cp / 100;
  const rounded = Math.abs(pawns) >= 10 ? pawns.toFixed(0) : pawns.toFixed(1);
  return `${pawns >= 0 ? "+" : ""}${rounded}`;
}

function labelDisplay(label: MoveStatusLabel) {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function parseInfoLine(line: string) {
  const rankMatch = line.match(/\bmultipv (\d+)/);
  const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pvMatch = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?[\s\S]*)$/i);
  if (!rankMatch || !scoreMatch || !pvMatch) return null;

  const rank = Number.parseInt(rankMatch[1], 10);
  const scoreType = scoreMatch[1];
  const scoreValue = Number.parseInt(scoreMatch[2], 10);
  const lineMoves = pvMatch[1].trim();
  const firstMove = lineMoves.split(/\s+/)[0] || null;
  const score: RawEngineScore = {
    cp: scoreType === "cp" ? scoreValue : null,
    mate: scoreType === "mate" ? scoreValue : null,
  };

  return {
    rank,
    move: firstMove,
    line: lineMoves,
    cp: score.cp,
    mate: score.mate,
    numeric: numericScore(score),
  } satisfies EnginePv;
}

function materialBalanceForSide(fen: string, side: "white" | "black") {
  const chess = new Chess(fen);
  const board = chess.board();
  let white = 0;
  let black = 0;

  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      const value = MATERIAL_VALUES[piece.type] ?? 0;
      if (piece.color === "w") white += value;
      else black += value;
    }
  }

  return side === "white" ? white - black : black - white;
}

function classifyMove(input: {
  move: AnalysisMoveInput;
  before: PositionEvaluation;
  after: PositionEvaluation;
}) {
  const { move, before, after } = input;
  const beforeScore = before.score?.numeric ?? 0;
  const afterScoreForMover = -(after.score?.numeric ?? 0);
  const centipawnLoss = Math.max(0, beforeScore - afterScoreForMover);
  const bestMove = before.bestMove;
  const isBestMove = Boolean(bestMove && bestMove === move.uci);
  const secondChoice = before.pvs.find((pv) => pv.rank === 2)?.numeric ?? beforeScore;
  const bestGap = beforeScore - secondChoice;
  const materialBefore = materialBalanceForSide(before.fen, move.color);
  const materialAfter = materialBalanceForSide(after.fen, move.color);
  const materialDelta = materialAfter - materialBefore;
  const foundSacrifice = materialDelta <= -3;
  const improvedPosition = afterScoreForMover - beforeScore;
  const isForced = before.legalMoveCount === 1;
  const missedMate = typeof before.score?.mate === "number" && before.score.mate > 0 && !isBestMove;
  const allowsMate = typeof after.score?.mate === "number" && after.score.mate > 0;

  let label: MoveStatusLabel;
  if (isForced) label = "forced";
  else if (missedMate || allowsMate || centipawnLoss >= 300) label = "blunder";
  else if (centipawnLoss >= 120) label = "mistake";
  else if (centipawnLoss >= 60) label = "inaccuracy";
  else if (isBestMove && foundSacrifice && afterScoreForMover >= beforeScore - 40) label = "brilliant";
  else if (isBestMove && (bestGap >= 180 || improvedPosition >= 150)) label = "great";
  else if (isBestMove && centipawnLoss <= 12) label = "best";
  else if (centipawnLoss <= 35) label = "excellent";
  else label = "good";

  return {
    label,
    display: labelDisplay(label),
    bestMove,
    isBestMove,
    centipawnLoss,
    materialDelta,
  };
}

async function createEngineRuntime(): Promise<StockfishRuntime> {
  const engine = await initStockfish("lite-single");
  const listeners = new Set<(line: string) => void>();

  engine.listener = (line: string) => {
    for (const listener of listeners) {
      listener(String(line));
    }
  };

  const onLine = (listener: (line: string) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const waitFor = (matcher: (line: string) => boolean) =>
    new Promise<void>((resolve) => {
      const off = onLine((line) => {
        if (!matcher(line)) return;
        off();
        resolve();
      });
    });

  engine.sendCommand("uci");
  await waitFor((line) => line === "uciok");
  engine.sendCommand(`setoption name Hash value ${ENGINE_HASH_MB}`);
  engine.sendCommand("setoption name Threads value 1");
  engine.sendCommand("isready");
  await waitFor((line) => line === "readyok");

  return {
    send(command: string) {
      engine.sendCommand(command);
    },
    onLine,
  };
}

async function getEngineRuntime() {
  if (!enginePromise) {
    enginePromise = createEngineRuntime();
  }
  return enginePromise;
}

async function runQueued<T>(task: () => Promise<T>) {
  const next = engineQueue.then(task, task);
  engineQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function evaluateFenUncached(fen: string): Promise<PositionEvaluation> {
  return runQueued(async () => {
    const runtime = await getEngineRuntime();
    const chess = new Chess(fen);
    const turn = chess.turn() === "w" ? "white" : "black";

    return new Promise<PositionEvaluation>((resolve, reject) => {
      const pending: PendingAnalysis = {
        fen,
        infoByRank: new Map<number, EnginePv>(),
        resolve,
        reject,
      };

      const timer = setTimeout(() => {
        off();
        reject(new Error(`Stockfish analysis timed out for ${fen}`));
      }, 20_000);

      const off = runtime.onLine((line) => {
        if (line.startsWith("info ")) {
          const parsed = parseInfoLine(line);
          if (parsed) pending.infoByRank.set(parsed.rank, parsed);
          return;
        }

        if (!line.startsWith("bestmove ")) return;
        clearTimeout(timer);
        off();

        const pvs = [...pending.infoByRank.values()].sort((a, b) => a.rank - b.rank);
        const top = pvs[0] ?? null;
        const score = top
          ? {
              cp: top.cp,
              mate: top.mate,
              numeric: top.numeric,
              whiteAdvantage: whiteAdvantage({ cp: top.cp, mate: top.mate }, turn),
              display: displayWhiteAdvantage({ cp: top.cp, mate: top.mate }, turn),
            }
          : null;

        pending.resolve({
          fen: pending.fen,
          turn,
          depth: ENGINE_DEPTH,
          bestMove: top?.move ?? null,
          score,
          legalMoveCount: chess.moves().length,
          pvs,
        });
      });

      runtime.send("ucinewgame");
      runtime.send("isready");
      runtime.send(`setoption name MultiPV value ${ENGINE_MULTI_PV}`);
      runtime.send(`position fen ${fen}`);
      runtime.send(`go depth ${ENGINE_DEPTH}`);
    });
  });
}

export async function evaluateFen(fen: string) {
  if (!positionCache.has(fen)) {
    positionCache.set(
      fen,
      evaluateFenUncached(fen).catch((error) => {
        positionCache.delete(fen);
        throw error;
      }),
    );
  }
  return positionCache.get(fen)!;
}

export async function analyzeReplayGame(gameData: {
  gameId: string;
  history: AnalysisMoveInput[];
}) {
  if (!gameCache.has(gameData.gameId)) {
    gameCache.set(
      gameData.gameId,
      (async (): Promise<ReplayEngineAnalysis> => {
        const chess = new Chess();
        const fens = [chess.fen()];
        for (const move of gameData.history) {
          chess.move(move.uci);
          fens.push(chess.fen());
        }

        const positions = await Promise.all(fens.map((fen) => evaluateFen(fen)));
        const moves = gameData.history.map((move, index) => {
          const before = positions[index];
          const after = positions[index + 1];
          const classified = classifyMove({ move, before, after });
          return {
            uci: move.uci,
            san: move.san,
            color: move.color,
            label: classified.label,
            display: classified.display,
            bestMove: classified.bestMove,
            isBestMove: classified.isBestMove,
            centipawnLoss: classified.centipawnLoss,
            materialDelta: classified.materialDelta,
            whiteAdvantageBefore: before.score?.whiteAdvantage ?? null,
            whiteAdvantageAfter: after.score?.whiteAdvantage ?? null,
          } satisfies MoveAnalysis;
        });

        return {
          engine: {
            name: "Stockfish 18 Lite",
            depth: ENGINE_DEPTH,
            multiPv: ENGINE_MULTI_PV,
          },
          positions,
          moves,
        };
      })().catch((error) => {
        gameCache.delete(gameData.gameId);
        throw error;
      }),
    );
  }

  return gameCache.get(gameData.gameId)!;
}
