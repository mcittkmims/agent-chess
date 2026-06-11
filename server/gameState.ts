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
  const context = state.context || {};
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
    context: {
      moveNumber: context.moveNumber,
      inCheck: context.inCheck,
      halfmoveClock: context.halfmoveClock,
      capturesAvailable: context.capturesAvailable || [],
      checksAvailable: context.checksAvailable || [],
      promotionsAvailable: context.promotionsAvailable || [],
    },
    updatedAt: state.updatedAt,
  };
}

function fullAgentState(state: any) {
  const context = state.context || {};
  return {
    ...compactState(state),
    context: {
      moveNumber: context.moveNumber,
      inCheck: context.inCheck,
      halfmoveClock: context.halfmoveClock,
      boardMap: context.boardMap || {},
      castling: context.castling || null,
      enPassant: context.enPassant ?? null,
      material: context.material || null,
    },
  };
}

function pollingGuidance(stateVersion: number, actionRequired: "join" | "wait" | "move" | "exit") {
  return {
    protocol: "http_polling_v1",
    waitEndpoint: "/api/wait",
    stateEndpoint: "/api/state",
    moveEndpoint: "/api/move",
    joinEndpoint: "/api/join",
    polling: {
      mode: "long_poll",
      lastSeenStateVersion: stateVersion,
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 20,
      immediateAction: actionRequired !== "wait",
      onTimeout: "repeat_same_wait_request_immediately",
      onStateChange: "inspect_actionRequired_then_move_or_wait",
      doNotWriteScripts: true,
    },
  };
}

function buildPerspective(state: any, color: "white" | "black" | null) {
  if (!color) return null;

  const opponent = color === "white" ? "black" : "white";
  const boardMap = state.context?.boardMap || {};
  const material = state.context?.material || {};
  const captured = material.captured || {};

  return {
    you: color,
    opponent,
    myPieces: boardMap[color] || {},
    opponentPieces: boardMap[opponent] || {},
    myLost: captured[color] || {},
    opponentLost: captured[opponent] || {},
    lastMoveByOpponent: state.lastMove ? state.lastMove.color !== color : false,
  };
}

function buildAgentGuidance(state: any, color: "white" | "black" | null, token: string | null) {
  const seat = color ? game.agents[color] : null;
  const availableColors = (["white", "black"] as const).filter((side) => !game.agents[side]);
  const authenticated = Boolean(color && token && seat && seat.token === token);

  let actionRequired: "join" | "wait" | "move" | "exit";
  let actionReason: string;

  if (state.gameOver) {
    actionRequired = "exit";
    actionReason = "game_over";
  } else if (!color) {
    if (availableColors.length > 0) {
      actionRequired = "join";
      actionReason = "seat_open";
    } else {
      actionRequired = "wait";
      actionReason = "seats_full";
    }
  } else if (!seat) {
    actionRequired = "join";
    actionReason = "seat_open";
  } else if (!token) {
    actionRequired = "wait";
    actionReason = "token_required";
  } else if (!authenticated) {
    actionRequired = "wait";
    actionReason = "token_invalid";
  } else if (state.turn === color) {
    actionRequired = "move";
    actionReason = "your_turn";
  } else {
    actionRequired = "wait";
    actionReason = "opponent_to_move";
  }

  return {
    requestedColor: color,
    authenticated,
    availableColors,
    actionRequired,
    actionReason,
    ...pollingGuidance(state.stateVersion, actionRequired),
  };
}

export function stateForAgent(options?: {
  color?: "white" | "black" | null;
  includeHistory?: boolean;
  token?: string | null;
  view?: "compact" | "full";
}): any {
  const { color = null, includeHistory = false, token = null, view = "compact" } = options || {};
  const state = includeHistory ? fullState() : slimState();
  const base = view === "compact" ? compactState(state) : fullAgentState(state);
  return {
    ...base,
    ...buildAgentGuidance(state, color, token),
    perspective: buildPerspective(state, color),
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
