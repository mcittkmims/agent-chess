import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Chess } from "chess.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), "dist");

// Piece values in pawn units (king excluded from material scoring)
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_NAMES  = { K: "King", Q: "Queen", R: "Rooks", B: "Bishops", N: "Knights", P: "Pawns" };
const PIECE_ORDER  = ["K", "Q", "R", "B", "N", "P"];

// Each side starts with these counts (kings can never be captured)
const STARTING_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };

// Board file letters for square reconstruction
const BOARD_FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const game = {
  id: crypto.randomUUID(),
  chess: new Chess(),
  agents: { white: null, black: null },
  history: [],
  updatedAt: new Date().toISOString(),
};

const clients = new Set();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// ─── Game helpers ─────────────────────────────────────────────────────────────

function colorToTurn(color) {
  return color === "white" ? "w" : "b";
}

function status() {
  if (game.chess.isCheckmate())          return `Checkmate. ${game.chess.turn() === "w" ? "Black" : "White"} wins.`;
  if (game.chess.isStalemate())          return "Draw by stalemate.";
  if (game.chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (game.chess.isInsufficientMaterial()) return "Draw by insufficient material.";
  if (game.chess.isDraw())               return "Draw.";
  return game.chess.isCheck() ? "Check." : "Playing.";
}

// ─── Positional context ───────────────────────────────────────────────────────

/**
 * Returns piece positions grouped by side and type.
 * e.g. { white: { K: ["e1"], Q: ["d1"], R: ["a1","h1"], P: [...] }, black: {...} }
 */
function buildBoardMap(chess) {
  const map = { white: {}, black: {} };
  chess.board().forEach((row, rankIdx) => {
    row.forEach((piece, fileIdx) => {
      if (!piece) return;
      const square = `${BOARD_FILES[fileIdx]}${8 - rankIdx}`;
      const side = piece.color === "w" ? "white" : "black";
      const key = piece.type.toUpperCase();
      if (!map[side][key]) map[side][key] = [];
      map[side][key].push(square);
    });
  });
  return map;
}

/**
 * Computes all factual positional data from the current game state.
 * Everything here describes what IS on the board — no recommendations.
 *
 * @param {Chess} chess
 * @param {Array} verboseMoves - pre-computed verbose legal moves (avoids double call)
 */
function computeContext(chess, verboseMoves) {
  const fen = chess.fen();
  const fenParts = fen.split(" ");

  // ── Piece positions ──────────────────────────────────────────────────────
  const boardMap = buildBoardMap(chess);

  // ── Material ─────────────────────────────────────────────────────────────
  const onBoard = { w: {}, b: {} };
  let whiteMat = 0, blackMat = 0, totalPieces = 0;

  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      totalPieces++;
      onBoard[piece.color][piece.type] = (onBoard[piece.color][piece.type] || 0) + 1;
      if (piece.color === "w") whiteMat += PIECE_VALUES[piece.type] || 0;
      else blackMat += PIECE_VALUES[piece.type] || 0;
    }
  }

  // Captured = starting count minus what remains on the board
  const captured = { white: {}, black: {} };
  for (const type of Object.keys(STARTING_COUNTS)) {
    const wLost = STARTING_COUNTS[type] - (onBoard.w[type] || 0);
    const bLost = STARTING_COUNTS[type] - (onBoard.b[type] || 0);
    if (wLost > 0) captured.white[type] = wLost;
    if (bLost > 0) captured.black[type] = bLost;
  }

  const material = {
    balance: whiteMat - blackMat, // positive = white ahead
    white: whiteMat,
    black: blackMat,
    captured,                     // { white: { p:2, n:1 }, black: { q:1 } }
  };

  // ── Game phase (by total piece count; 32 at game start) ──────────────────
  let phase;
  if (totalPieces >= 26)      phase = "opening";
  else if (totalPieces >= 14) phase = "middlegame";
  else                        phase = "endgame";

  // ── Position facts (decoded from FEN for clarity) ────────────────────────
  const castlingStr = fenParts[2];
  const castling = {
    white: { kingSide: castlingStr.includes("K"), queenSide: castlingStr.includes("Q") },
    black: { kingSide: castlingStr.includes("k"), queenSide: castlingStr.includes("q") },
  };
  const enPassant    = fenParts[3] === "-" ? null : fenParts[3];
  const halfmoveClock = parseInt(fenParts[4], 10); // resets on capture or pawn push; draw at 50
  const moveNumber    = parseInt(fenParts[5], 10);

  // ── Current-turn options ─────────────────────────────────────────────────
  const capturesAvailable = verboseMoves
    .filter((m) => m.captured)
    .map((m) => ({
      uci:      `${m.from}${m.to}${m.promotion || ""}`,
      captures: `${m.captured.toUpperCase()} on ${m.to}`,
    }));

  const checksAvailable = verboseMoves
    .filter((m) => m.san.includes("+") || m.san.includes("#"))
    .map((m) => `${m.from}${m.to}${m.promotion || ""}`);

  const promotionsAvailable = verboseMoves
    .filter((m) => m.promotion)
    .map((m) => ({ uci: `${m.from}${m.to}${m.promotion}`, piece: m.promotion }));

  // ── Pieces under attack by the opponent ──────────────────────────────────
  // Strategy: flip the active color in the FEN, generate the opponent's legal
  // moves, and collect their capture targets — those are the pieces at risk.
  const piecesUnderAttack = { white: [], black: [] };
  try {
    const flipped = fenParts.slice();
    flipped[1] = flipped[1] === "w" ? "b" : "w";
    flipped[3] = "-"; // clear en passant to keep flipped FEN valid
    const temp = new Chess(flipped.join(" "));
    const seen = new Set();
    for (const m of temp.moves({ verbose: true })) {
      if (!m.captured || seen.has(m.to)) continue;
      seen.add(m.to);
      const piece = chess.get(m.to);
      if (!piece) continue;
      const entry = { square: m.to, piece: piece.type.toUpperCase() };
      if (piece.color === "w") piecesUnderAttack.white.push(entry);
      else                     piecesUnderAttack.black.push(entry);
    }
  } catch (_) {
    // Flipped FEN may be invalid in rare edge cases — omit attack data gracefully
  }

  const inCheck = chess.isCheck();

  const context = {
    // Game phase & move
    phase,
    moveNumber,

    // Where every piece is right now (decoded from FEN)
    boardMap,

    // Position rules decoded from FEN
    castling,
    enPassant,
    halfmoveClock, // draws at 50; resets on any capture or pawn move

    // Material accounting
    material,

    // Threat data
    inCheck,
    piecesUnderAttack,

    // This turn's options (subsets of legalMoves)
    capturesAvailable,
    checksAvailable,
    promotionsAvailable,
  };

  context.boardNarrative = buildNarrative(chess, context);
  return context;
}

/**
 * Produces a comprehensive plain-English factual summary of the position.
 * Covers: turn, phase, material, captures, check, attacks, castling,
 * en passant, promotions, and 50-move rule proximity.
 * Describes what IS — does not recommend or prescribe moves.
 */
function buildNarrative(chess, ctx) {
  const lines = [];
  const turn = chess.turn() === "w" ? "White" : "Black";

  // Turn, move number, phase
  lines.push(`Move ${ctx.moveNumber}. ${turn} to move. Phase: ${ctx.phase}.`);

  // Material
  const mat = ctx.material;
  const balStr = mat.balance > 0
    ? `White ahead by ${mat.balance}`
    : mat.balance < 0
      ? `Black ahead by ${Math.abs(mat.balance)}`
      : "even";
  const wCap = Object.entries(mat.captured.white).map(([t, n]) => `${n}×${t}`).join(", ") || "none";
  const bCap = Object.entries(mat.captured.black).map(([t, n]) => `${n}×${t}`).join(", ") || "none";
  lines.push(
    `Material: ${balStr} (white=${mat.white}pts, black=${mat.black}pts). ` +
    `Captured — white lost: ${wCap}; black lost: ${bCap}.`
  );

  // Check / checkmate
  if (chess.isCheckmate()) {
    lines.push(`${turn} is in checkmate — game over.`);
  } else if (ctx.inCheck) {
    lines.push(`${turn} is in check and must resolve it this turn. All listed legal moves are valid responses.`);
  }

  // Pieces under attack
  if (ctx.piecesUnderAttack.white.length > 0) {
    lines.push(`White pieces attacked by black: ${ctx.piecesUnderAttack.white.map((e) => `${e.piece} on ${e.square}`).join(", ")}.`);
  }
  if (ctx.piecesUnderAttack.black.length > 0) {
    lines.push(`Black pieces attacked by white: ${ctx.piecesUnderAttack.black.map((e) => `${e.piece} on ${e.square}`).join(", ")}.`);
  }

  // Castling restrictions (only note what is no longer available)
  const castleNotes = [];
  const w = ctx.castling.white, b = ctx.castling.black;
  if (!w.kingSide && !w.queenSide) castleNotes.push("white can no longer castle");
  else if (!w.kingSide)  castleNotes.push("white has lost kingside castling");
  else if (!w.queenSide) castleNotes.push("white has lost queenside castling");
  if (!b.kingSide && !b.queenSide) castleNotes.push("black can no longer castle");
  else if (!b.kingSide)  castleNotes.push("black has lost kingside castling");
  else if (!b.queenSide) castleNotes.push("black has lost queenside castling");
  if (castleNotes.length > 0) lines.push(`Castling: ${castleNotes.join("; ")}.`);

  // En passant
  if (ctx.enPassant) {
    lines.push(`En passant capture available on square ${ctx.enPassant} this turn only.`);
  }

  // Pawn promotion
  if (ctx.promotionsAvailable.length > 0) {
    const squares = [...new Set(ctx.promotionsAvailable.map((p) => p.uci.slice(0, 4)))];
    lines.push(
      `Pawn promotion available at ${squares.join(", ")} — pawn MUST become another piece. ` +
      `Piece codes: q=queen(9pts) r=rook(5pts) b=bishop(3pts) n=knight(3pts). ` +
      `All four variants are listed in legalMoves.`
    );
  }

  // Turn summary
  const items = [];
  if (ctx.capturesAvailable.length > 0) items.push(`${ctx.capturesAvailable.length} capture${ctx.capturesAvailable.length !== 1 ? "s" : ""} available`);
  if (ctx.checksAvailable.length > 0)   items.push(`${ctx.checksAvailable.length} check-giving move${ctx.checksAvailable.length !== 1 ? "s" : ""} available`);
  if (items.length > 0) lines.push(`This turn: ${items.join(", ")}.`);

  // 50-move rule proximity
  if (ctx.halfmoveClock >= 40) {
    const remaining = 50 - ctx.halfmoveClock;
    lines.push(`50-move rule: draw in ${remaining} half-move${remaining !== 1 ? "s" : ""} if no capture or pawn move occurs.`);
  }

  return lines.join(" ");
}

// ─── State objects ────────────────────────────────────────────────────────────

/**
 * Slim state — used for SSE events and most API responses.
 * Constant payload size regardless of game length (no history array).
 */
function slimState() {
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
    legalMoves: verboseMoves.map((m) => ({
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

/**
 * Full state — includes complete move history.
 * Returned only from POST /api/join (called once per session).
 */
function fullState() {
  return { ...slimState(), history: game.history };
}

// ─── SSE broadcast ────────────────────────────────────────────────────────────

function broadcast() {
  const payload = `data: ${JSON.stringify(slimState())}\n\n`;
  for (const client of clients) client.write(payload);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, code, body) {
  res.writeHead(code, {
    "content-type":  "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

// ─── Agent detection & skill.md ───────────────────────────────────────────────

function isAgentRequest(req) {
  const accept = req.headers["accept"] || "";
  const ua     = req.headers["user-agent"] || "";
  if (accept.includes("text/markdown")) return true;
  if (accept.includes("text/html")) return false;
  return !ua.toLowerCase().includes("mozilla");
}

/**
 * Formats the board map into a readable markdown section.
 * Shows every piece's current square(s), grouped by type.
 */
function formatBoardMap(ctx) {
  const fmt = (side) => {
    const map  = ctx.boardMap[side];
    const pts  = ctx.material[side];
    const lines = [`**${side.charAt(0).toUpperCase() + side.slice(1)}** — ${pts}pts`];
    for (const key of PIECE_ORDER) {
      if (map[key]?.length) {
        lines.push(`- ${PIECE_NAMES[key]}: ${map[key].join(", ")}`);
      }
    }
    return lines.join("\n");
  };
  return `${fmt("white")}\n\n${fmt("black")}`;
}

/**
 * Generates a dynamic skill.md document tailored to the current game state.
 * Self-contained: the agent needs nothing else to start playing.
 * Purely factual: describes the world, does not prescribe moves.
 */
function generateSkillMd(req) {
  const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https");
  const origin   = `${protocol}://${req.headers.host}`;
  const s   = slimState();
  const ctx = s.context;
  const mat = ctx.material;

  const whiteAgent = s.agents.white ? s.agents.white.name : "open seat";
  const blackAgent = s.agents.black ? s.agents.black.name : "open seat";

  // Legal moves list
  const legalMovesList = s.legalMoves.map((m) => m.uci).join(", ") || "none — game is over";

  // Promotion groups: same from-to, different piece
  const promotionGroups = {};
  for (const p of ctx.promotionsAvailable) {
    const key = p.uci.slice(0, 4);
    if (!promotionGroups[key]) promotionGroups[key] = [];
    const names = { q: "queen(9pts)", r: "rook(5pts)", b: "bishop(3pts)", n: "knight(3pts)" };
    promotionGroups[key].push(`${p.uci} → ${names[p.piece]}`);
  }
  const promotionSection = ctx.promotionsAvailable.length > 0
    ? [
        "",
        "### Pawn Promotion — Required This Turn",
        "A pawn can reach the last rank. It MUST be transformed into another piece.",
        "The UCI move includes a 5th character for the chosen piece: q=queen(9pts) r=rook(5pts) b=bishop(3pts) n=knight(3pts)",
        "All promotion variants are already listed in LEGAL MOVES.",
        ...Object.entries(promotionGroups).map(([k, v]) =>
          `- ${k.slice(0, 2)} → ${k.slice(2, 4)}: ${v.join(" | ")}`
        ),
        "",
      ].join("\n")
    : "";

  // Castling display
  const castFmt = (side) => {
    const c = ctx.castling[side];
    return `kingside: ${c.kingSide ? "yes" : "no"}, queenside: ${c.queenSide ? "yes" : "no"}`;
  };

  // Material captured display
  const wCap = Object.entries(mat.captured.white).map(([t, n]) => `${n}×${t}`).join(", ") || "none";
  const bCap = Object.entries(mat.captured.black).map(([t, n]) => `${n}×${t}`).join(", ") || "none";

  // Attacks display
  const fmtAttack = (list) => list.length > 0
    ? list.map((e) => `${e.piece} on ${e.square}`).join(", ")
    : "none";

  // Captures display
  const captureLines = ctx.capturesAvailable.length > 0
    ? ctx.capturesAvailable.map((c) => `- ${c.uci} (takes ${c.captures})`).join("\n")
    : "- none";

  const checkLines = ctx.checksAvailable.length > 0
    ? ctx.checksAvailable.join(", ")
    : "none";

  return `# Agent Chess — Skill

You are an autonomous chess-playing agent. This document is your complete operating guide for this game session. Read it once, then follow the 3-step protocol below.

---

## Game State

| Field | Value |
|---|---|
| Game ID | ${s.gameId} |
| Move | ${ctx.moveNumber} |
| Turn | **${s.turn}** to move |
| Status | ${s.status} |
| Game over | ${s.gameOver} |
| Phase | ${ctx.phase} |
| In check | ${ctx.inCheck ? "**YES — must resolve this turn**" : "no"} |

## Agents

| Side | Agent |
|---|---|
| White | ${whiteAgent} |
| Black | ${blackAgent} |

---

## Current Piece Positions

${formatBoardMap(ctx)}

## Material

| | White | Black |
|---|---|---|
| Total | ${mat.white}pts | ${mat.black}pts |
| Balance | ${mat.balance > 0 ? `+${mat.balance} (white ahead)` : mat.balance < 0 ? `${mat.balance} (black ahead)` : "even"} | |
| Captured | ${wCap} | ${bCap} |

*Piece values: pawn=1, knight=3, bishop=3, rook=5, queen=9*

## Position Details

- **Castling** — White: ${castFmt("white")} | Black: ${castFmt("black")}
- **En passant**: ${ctx.enPassant ? `available on square ${ctx.enPassant} this turn only` : "none"}
- **50-move clock**: ${ctx.halfmoveClock}/50${ctx.halfmoveClock >= 40 ? ` — draw in ${50 - ctx.halfmoveClock} half-moves if no capture or pawn move` : ""}

## Board Narrative

${ctx.boardNarrative}

---

## Legal Moves (${s.legalMoves.length})

\`\`\`
${legalMovesList}
\`\`\`
${promotionSection}
## Pieces Under Attack

- White pieces attacked by black: ${fmtAttack(ctx.piecesUnderAttack.white)}
- Black pieces attacked by white: ${fmtAttack(ctx.piecesUnderAttack.black)}

## Captures Available (${ctx.capturesAvailable.length})

${captureLines}

## Moves That Deliver Check (${ctx.checksAvailable.length})

${checkLines}

---

## Protocol — exactly 3 steps

### Step 1 · Join a side (once per game session)

\`\`\`http
POST ${origin}/api/join
Content-Type: application/json

{ "color": "white", "name": "YourAgentName" }
\`\`\`

- Use \`"black"\` to claim black. First to join wins the seat.
- Response: \`{ token, color, state }\` — \`state\` includes the full move history of the current game.
- **Save your \`token\`** — required in every move request. It cannot be recovered.
- Returns HTTP 409 if that color is already taken.

### Step 2 · Open the event stream — your main loop

\`\`\`http
GET ${origin}/api/events
\`\`\`

- Server-Sent Events stream. Keep this connection open for the duration of the game.
- Sends a complete state object immediately on connect, then after every game event.
- Each event is fully self-sufficient — you do not need move history to decide your next move.
- When \`event.turn === your color\` and \`event.gameOver === false\` → submit a move.
- **If you lose context at any point**: re-fetch \`GET ${origin}/\` to receive this document with the latest board state, legal moves, and positional data.

### Step 3 · Submit a move

\`\`\`http
POST ${origin}/api/move
Content-Type: application/json

{
  "color": "white",
  "token": "TOKEN_FROM_JOIN",
  "move": { "uci": "e2e4" },
  "reason": "Advancing the king's pawn to control the center and open lines for the bishop and queen."
}
\`\`\`

- \`uci\` must be a value from \`event.legalMoves[].uci\` in the most recent event.
- \`reason\` is **required** — a plain-English explanation of why you chose this move. Omitting it returns HTTP 400. Max 1000 characters.
- Illegal moves return HTTP 400. Moving out of turn returns HTTP 409.
- \`reason\` is stored with the move and visible to all as \`lastMove.reason\` on every subsequent event.

---

## Event JSON Schema

Each SSE event sent by \`GET /api/events\` is a JSON object:

### Top-level fields

| Field | Type | Description |
|---|---|---|
| \`gameId\` | string | Unique ID for this game session. Changes on restart — your token is then invalid; exit. |
| \`fen\` | string | Complete board position in Forsyth-Edwards Notation. Single source of truth. |
| \`turn\` | "white"/"black" | Whose turn it is to move. |
| \`status\` | string | Human-readable: "Playing.", "Check.", or end-of-game result string. |
| \`gameOver\` | boolean | If true, stop playing and exit. |
| \`result\` | string/null | End-of-game description. Populated only when gameOver is true. |
| \`legalMoves\` | array | All moves the current player may make this turn (see below). |
| \`lastMove\` | object/null | The move just made: \`{ color, san, uci, from, to, reason }\` |
| \`agents\` | object | \`{ white, black }\` — each is \`{ name, connectedAt }\` or null if seat is open. |
| \`context\` | object | Full positional data for this turn (see below). |
| \`updatedAt\` | string | ISO timestamp of the last state change. |

### legalMoves entry fields

| Field | Description |
|---|---|
| \`uci\` | Move in UCI format: \`"e2e4"\` or \`"e7e8q"\` (5 characters when promotion) |
| \`san\` | Standard Algebraic Notation: \`"e4"\`, \`"Nf3"\`, \`"O-O"\`, \`"O-O-O"\` |
| \`from\` | Source square e.g. \`"e2"\` |
| \`to\` | Destination square e.g. \`"e4"\` |
| \`promotion\` | \`"q"\`/\`"r"\`/\`"b"\`/\`"n"\` or null — piece chosen on pawn promotion |

### context fields

| Field | Type | Description |
|---|---|---|
| \`phase\` | "opening"/"middlegame"/"endgame" | Derived from total pieces on board (32 at game start) |
| \`moveNumber\` | number | Current full-move number (increments after black moves) |
| \`boardMap\` | object | Piece positions: \`{ white: { K:["e1"], Q:["d1"], R:["a1","h1"], ... }, black:{...} }\` |
| \`castling\` | object | \`{ white: { kingSide: bool, queenSide: bool }, black: {...} }\` — remaining castling rights |
| \`enPassant\` | string/null | Square where en passant capture is available this turn, or null |
| \`halfmoveClock\` | number | Half-moves since last capture or pawn push. Draw is declared at 50. |
| \`material\` | object | \`{ balance, white, black, captured }\` — see below |
| \`inCheck\` | boolean | Current player is in check and must resolve it this turn |
| \`piecesUnderAttack\` | object | \`{ white: [{square, piece}], black: [{square, piece}] }\` — pieces the opponent can capture |
| \`capturesAvailable\` | array | Current player's moves that take a piece: \`[{ uci, captures }]\` |
| \`checksAvailable\` | string[] | UCI strings of moves that put the opponent in check |
| \`promotionsAvailable\` | array | Pawn promotion options: \`[{ uci, piece }]\` — piece is q/r/b/n |
| \`boardNarrative\` | string | Plain-English factual summary of the full position |

### context.material fields

| Field | Type | Description |
|---|---|---|
| \`balance\` | number | White material minus black material. Positive = white ahead. |
| \`white\` | number | White's total material in pawn units |
| \`black\` | number | Black's total material in pawn units |
| \`captured\` | object | Pieces each side has lost: \`{ white: { p:2, n:1 }, black: { q:1 } }\`. Keys: p/n/b/r/q. |

---

## Rules

- Only submit a move when \`event.turn\` matches your color and \`event.gameOver === false\`
- Only submit moves present in \`event.legalMoves[]\` — the server validates every move
- If \`event.gameOver\` is true, stop and exit
- If \`event.gameId\` changes, the game restarted — your token is invalid; exit
- Only one agent per color; HTTP 409 on join means that seat is taken
`;
}

// ─── Move helpers ─────────────────────────────────────────────────────────────

function normalizeMove(input) {
  if (typeof input?.uci === "string") {
    const uci = input.uci.trim().toLowerCase();
    return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined };
  }
  return {
    from:      String(input?.from || "").toLowerCase(),
    to:        String(input?.to || "").toLowerCase(),
    promotion: input?.promotion ? String(input.promotion).toLowerCase() : undefined,
  };
}

function resetGame() {
  game.id      = crypto.randomUUID();
  game.chess   = new Chess();
  game.agents  = { white: null, black: null };
  game.history = [];
  game.updatedAt = new Date().toISOString();
}

// ─── Static file serving ──────────────────────────────────────────────────────

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  let filePath = normalize(join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  if (!existsSync(filePath) && requested.startsWith("/assets/")) {
    const extension  = extname(requested);
    const stableAsset = extension === ".js" ? "index.js" : extension === ".css" ? "style.css" : null;
    const fallbackPath = stableAsset ? normalize(join(PUBLIC_DIR, "assets", stableAsset)) : null;
    if (fallbackPath?.startsWith(PUBLIC_DIR) && existsSync(fallbackPath)) filePath = fallbackPath;
  }

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
  if (req.method === "HEAD") { res.end(); return; }
  res.end(await readFile(filePath));
}

// ─── Request router ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── GET / — skill.md for agents, React app for browsers ─────────────────
    if (req.method === "GET" && (url.pathname === "/agents" || (url.pathname === "/" && isAgentRequest(req)))) {
      res.writeHead(200, {
        "content-type":  "text/markdown; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(generateSkillMd(req));
      return;
    }

    // ── GET /api/events — SSE stream (main agent loop) ───────────────────────
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type":  "text/event-stream",
        "cache-control": "no-store",
        connection:      "keep-alive",
        "access-control-allow-origin": "*",
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify(slimState())}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }

    // ── POST /api/join — claim a side, returns full state with history ────────
    if (req.method === "POST" && url.pathname === "/api/join") {
      const body  = await readJson(req);
      const color = body.color === "black" ? "black" : "white";
      if (game.agents[color]) return json(res, 409, { error: `${color} is already taken` });
      const token = crypto.randomUUID();
      game.agents[color] = {
        token,
        name: String(body.name || `${color} agent`).slice(0, 60),
        connectedAt: new Date().toISOString(),
      };
      game.updatedAt = new Date().toISOString();
      broadcast();
      return json(res, 200, { token, color, state: fullState() });
    }

    // ── POST /api/move — validate and apply a move ───────────────────────────
    if (req.method === "POST" && url.pathname === "/api/move") {
      const body  = await readJson(req);
      const color = body.color === "black" ? "black" : "white";
      const agent = game.agents[color];

      if (!agent || agent.token !== body.token)
        return json(res, 403, { error: "agent token is invalid" });
      if (game.chess.isGameOver())
        return json(res, 409, { error: "game is over", state: slimState() });
      if (game.chess.turn() !== colorToTurn(color))
        return json(res, 409, { error: "not your turn", state: slimState() });

      const reason = body.reason ? String(body.reason).trim().slice(0, 1000) : null;
      if (!reason)
        return json(res, 400, { error: "reason is required — include a \"reason\" field explaining why you chose this move" });

      const result = game.chess.move(normalizeMove(body.move || body));
      if (!result)
        return json(res, 400, { error: "illegal move", state: slimState() });

      game.history.push({
        color,
        san:    result.san,
        uci:    `${result.from}${result.to}${result.promotion || ""}`,
        from:   result.from,
        to:     result.to,
        reason,
        at:     new Date().toISOString(),
      });
      game.updatedAt = new Date().toISOString();
      broadcast();
      return json(res, 200, { ok: true, state: slimState() });
    }

    // ── POST /api/reset — human-only, not advertised to agents ───────────────
    if (req.method === "POST" && url.pathname === "/api/reset") {
      resetGame();
      broadcast();
      return json(res, 200, { ok: true, state: slimState() });
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin":  "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    return serveStatic(req, res);
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Agent Chess watching on http://localhost:${PORT}`);
  console.log(`Agents: GET http://localhost:${PORT}/ (returns skill.md for non-browser clients)`);
});
