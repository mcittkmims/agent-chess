import { Chess } from "chess.js";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeContext } from "./context.js";
import { GameState, ClientConnection } from "./types.js";

export const game: GameState = {
  id: crypto.randomUUID(),
  stateVersion: 1,
  chess: new Chess(),
  agents: { white: null, black: null },
  history: [],
  updatedAt: new Date().toISOString(),
};

export const clients = new Set<ClientConnection>();

export function touchGame() {
  game.stateVersion += 1;
  game.updatedAt = new Date().toISOString();
}

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
    stateVersion: game.stateVersion,
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

function compactState(state: any) {
  return {
    gameId: state.gameId,
    stateVersion: state.stateVersion,
    fen: state.fen,
    turn: state.turn,
    status: state.status,
    gameOver: state.gameOver,
    result: state.result,
    legalMoves: state.legalMoves,
    lastMove: state.lastMove,
    agents: state.agents,
    updatedAt: state.updatedAt,
  };
}

function buildAgentGuidance(state: any, color: "white" | "black" | null, token: string | null) {
  const seat = color ? game.agents[color] : null;
  const availableColors = (["white", "black"] as const).filter((side) => !game.agents[side]);
  const authenticated = Boolean(color && token && seat && seat.token === token);

  let actionRequired: "join" | "wait" | "move" | "exit";
  let actionReason: string;
  let recommendedAction: string;

  if (state.gameOver) {
    actionRequired = "exit";
    actionReason = "game_over";
    recommendedAction = "stop_playing_and_exit";
  } else if (!color) {
    if (availableColors.length > 0) {
      actionRequired = "join";
      actionReason = "seat_open";
      recommendedAction = "post_join_for_an_open_seat";
    } else {
      actionRequired = "wait";
      actionReason = "seats_full";
      recommendedAction = "observe_or_retry_after_reset";
    }
  } else if (!seat) {
    actionRequired = "join";
    actionReason = "seat_open";
    recommendedAction = "post_join_for_requested_color";
  } else if (!token) {
    actionRequired = "wait";
    actionReason = "token_required";
    recommendedAction = "use_saved_token_or_rejoin_after_reset";
  } else if (!authenticated) {
    actionRequired = "wait";
    actionReason = "token_invalid";
    recommendedAction = "rejoin_if_game_restarted_or_watch_until_reset";
  } else if (state.turn === color) {
    actionRequired = "move";
    actionReason = "your_turn";
    recommendedAction = "submit_one_legal_move";
  } else {
    actionRequired = "wait";
    actionReason = "opponent_to_move";
    recommendedAction = "wait_for_next_event";
  }

  return {
    requestedColor: color,
    authenticated,
    availableColors,
    actionRequired,
    actionReason,
    recommendedAction,
  };
}

export function stateForAgent(options?: {
  color?: "white" | "black" | null;
  includeHistory?: boolean;
  token?: string | null;
  view?: "compact" | "full";
}): any {
  const { color = null, includeHistory = false, token = null, view = "full" } = options || {};
  const state = includeHistory ? fullState() : slimState();
  const base = view === "compact" ? compactState(state) : state;
  return {
    ...base,
    ...buildAgentGuidance(state, color, token),
  };
}

export function broadcast() {
  for (const client of clients) {
    const payload = `data: ${JSON.stringify(stateForAgent({
      color: client.color,
      token: client.token,
      view: client.view,
    }))}\n\n`;
    client.res.write(payload);
  }
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
  game.stateVersion = 1;
  game.chess   = new Chess();
  game.agents  = { white: null, black: null };
  game.history = [];
  game.updatedAt = new Date().toISOString();
}
