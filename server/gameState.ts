import { Chess } from "chess.js";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeContext } from "./context.js";
import { GameState, ClientConnection } from "./types.js";

export const game: GameState = {
  id: crypto.randomUUID(),
  chess: new Chess(),
  agents: { white: null, black: null },
  history: [],
  updatedAt: new Date().toISOString(),
};

export const clients = new Set<ClientConnection>();

export function status() {
  if (game.chess.isCheckmate())          return `Checkmate. ${game.chess.turn() === "w" ? "Black" : "White"} wins.`;
  if (game.chess.isStalemate())          return "Draw by stalemate.";
  if (game.chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (game.chess.isInsufficientMaterial()) return "Draw by insufficient material.";
  if (game.chess.isDraw())               return "Draw.";
  return game.chess.isCheck() ? "Check." : "Playing.";
}

export function slimState() {
  const gameOver = game.chess.isGameOver();
  const verboseMoves = gameOver ? [] : game.chess.moves({ verbose: true });
  const context = computeContext(game.chess, verboseMoves);

  return {
    gameId:   game.id,
    fen:      game.chess.fen(),
    turn:     game.chess.turn() === "w" ? "white" : "black",
    status:   status(),
    gameOver,
    result:   gameOver ? status() : null,
    agents: {
      white: game.agents.white ? { name: game.agents.white.name, connectedAt: game.agents.white.connectedAt } : null,
      black: game.agents.black ? { name: game.agents.black.name, connectedAt: game.agents.black.connectedAt } : null,
    },
    legalMoves: verboseMoves.map((m: any) => ({
      from:      m.from,
      to:        m.to,
      san:       m.san,
      uci:       `${m.from}${m.to}${m.promotion || ""}`,
      promotion: m.promotion || null,
    })),
    lastMove:  game.history.at(-1) || null,
    context,
    updatedAt: game.updatedAt,
  };
}

export function fullState() {
  return { ...slimState(), history: game.history };
}

export function broadcast() {
  const payload = `data: ${JSON.stringify(slimState())}\n\n`;
  for (const client of clients) client.write(payload);
}

export async function saveGameToFile() {
  try {
    const data = fullState();
    const dir = join(process.cwd(), "data", "games");
    if (!existsSync(dir)) {
      await import("node:fs/promises").then(fs => fs.mkdir(dir, { recursive: true }));
    }
    const filePath = join(dir, `game-${data.gameId}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save game:", err);
  }
}

export function resetGame() {
  game.id      = crypto.randomUUID();
  game.chess   = new Chess();
  game.agents  = { white: null, black: null };
  game.history = [];
  game.updatedAt = new Date().toISOString();
}
