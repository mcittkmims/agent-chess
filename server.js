import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Chess } from "chess.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), "dist");

// Standard piece values in pawn units (king excluded from material count)
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

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
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// ─── Game helpers ────────────────────────────────────────────────────────────

function colorToTurn(color) {
  return color === "white" ? "w" : "b";
}

function status() {
  if (game.chess.isCheckmate()) return `Checkmate. ${game.chess.turn() === "w" ? "Black" : "White"} wins.`;
  if (game.chess.isStalemate()) return "Draw by stalemate.";
  if (game.chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (game.chess.isInsufficientMaterial()) return "Draw by insufficient material.";
  if (game.chess.isDraw()) return "Draw.";
  return game.chess.isCheck() ? "Check." : "Playing.";
}

// ─── Positional context ──────────────────────────────────────────────────────

/**
 * Computes factual positional data from the current chess state.
 * All fields describe what IS — no strategic recommendations.
 * @param {Chess} chess
 * @param {Array} verboseMoves - already-computed verbose legal moves (avoids double call)
 */
function computeContext(chess, verboseMoves) {
  // Material and piece count
  let whiteMaterial = 0, blackMaterial = 0, totalPieces = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      totalPieces++;
      const value = PIECE_VALUES[piece.type] || 0;
      if (piece.color === "w") whiteMaterial += value;
      else blackMaterial += value;
    }
  }

  // Game phase by total piece count (32 at start)
  let phase;
  if (totalPieces >= 26) phase = "opening";
  else if (totalPieces >= 14) phase = "middlegame";
  else phase = "endgame";

  // Captures the current player can make
  const capturesAvailable = verboseMoves
    .filter((m) => m.captured)
    .map((m) => ({
      uci: `${m.from}${m.to}${m.promotion || ""}`,
      captures: `${m.captured.toUpperCase()} on ${m.to}`,
    }));

  // Moves that give check (detected via SAN notation: "+" or "#")
  const checksAvailable = verboseMoves
    .filter((m) => m.san.includes("+") || m.san.includes("#"))
    .map((m) => `${m.from}${m.to}${m.promotion || ""}`);

  // Pawn promotion options
  const promotionsAvailable = verboseMoves
    .filter((m) => m.promotion)
    .map((m) => ({ uci: `${m.from}${m.to}${m.promotion}`, piece: m.promotion }));

  // Pieces under attack by opponent:
  // Temporarily flip the active color in the FEN to generate the opponent's captures.
  const piecesUnderAttack = { white: [], black: [] };
  try {
    const parts = chess.fen().split(" ");
    parts[1] = parts[1] === "w" ? "b" : "w";
    parts[3] = "-"; // clear en passant to keep flipped FEN valid
    const temp = new Chess(parts.join(" "));
    const seen = new Set();
    for (const m of temp.moves({ verbose: true })) {
      if (!m.captured || seen.has(m.to)) continue;
      seen.add(m.to);
      const piece = chess.get(m.to);
      if (!piece) continue;
      const entry = { square: m.to, piece: piece.type.toUpperCase() };
      if (piece.color === "w") piecesUnderAttack.white.push(entry);
      else piecesUnderAttack.black.push(entry);
    }
  } catch (_) {
    // Flipped FEN invalid in rare edge cases — omit attack data gracefully
  }

  const inCheck = chess.isCheck();

  const context = {
    phase,
    materialBalance: whiteMaterial - blackMaterial,
    whiteMaterial,
    blackMaterial,
    inCheck,
    capturesAvailable,
    checksAvailable,
    promotionsAvailable,
    piecesUnderAttack,
  };

  context.boardNarrative = buildNarrative(chess, context);
  return context;
}

/**
 * Produces a plain-English factual summary of the position.
 * Describes what is true — does not recommend moves or strategies.
 */
function buildNarrative(chess, ctx) {
  const parts = [];
  const turn = chess.turn() === "w" ? "White" : "Black";

  parts.push(`${turn} to move. Phase: ${ctx.phase}.`);

  if (ctx.materialBalance === 0) {
    parts.push("Material is equal.");
  } else if (ctx.materialBalance > 0) {
    const d = ctx.materialBalance;
    parts.push(`White leads by ${d} material point${d !== 1 ? "s" : ""} (pawn=1 knight/bishop=3 rook=5 queen=9).`);
  } else {
    const d = Math.abs(ctx.materialBalance);
    parts.push(`Black leads by ${d} material point${d !== 1 ? "s" : ""} (pawn=1 knight/bishop=3 rook=5 queen=9).`);
  }

  if (chess.isCheckmate()) {
    parts.push(`${turn} is in checkmate — game over.`);
  } else if (ctx.inCheck) {
    parts.push(`${turn} is in check and must resolve it this turn. All listed legal moves are valid responses.`);
  }

  if (ctx.piecesUnderAttack.white.length > 0) {
    parts.push(`White pieces currently attacked by black: ${ctx.piecesUnderAttack.white.map((e) => `${e.piece} on ${e.square}`).join(", ")}.`);
  }
  if (ctx.piecesUnderAttack.black.length > 0) {
    parts.push(`Black pieces currently attacked by white: ${ctx.piecesUnderAttack.black.map((e) => `${e.piece} on ${e.square}`).join(", ")}.`);
  }

  if (ctx.promotionsAvailable.length > 0) {
    const pawns = [...new Set(ctx.promotionsAvailable.map((p) => p.uci.slice(0, 4)))];
    parts.push(
      `Pawn promotion is available this turn (${pawns.join(", ")}). ` +
      `The pawn MUST transform into another piece. ` +
      `Piece codes in UCI: q=queen(9pts) r=rook(5pts) b=bishop(3pts) n=knight(3pts).`
    );
  }

  if (ctx.capturesAvailable.length > 0) {
    parts.push(`${ctx.capturesAvailable.length} capture${ctx.capturesAvailable.length !== 1 ? "s" : ""} available this turn.`);
  }
  if (ctx.checksAvailable.length > 0) {
    parts.push(`${ctx.checksAvailable.length} move${ctx.checksAvailable.length !== 1 ? "s" : ""} available that deliver check.`);
  }

  return parts.join(" ");
}

// ─── State objects ───────────────────────────────────────────────────────────

/**
 * Slim state — used for SSE events and API responses.
 * Constant size regardless of game length (no history array).
 */
function slimState() {
  const gameOver = game.chess.isGameOver();
  const verboseMoves = gameOver ? [] : game.chess.moves({ verbose: true });
  const context = computeContext(game.chess, verboseMoves);

  return {
    gameId: game.id,
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? "white" : "black",
    status: status(),
    gameOver,
    result: gameOver ? status() : null,
    agents: {
      white: game.agents.white ? { name: game.agents.white.name, connectedAt: game.agents.white.connectedAt } : null,
      black: game.agents.black ? { name: game.agents.black.name, connectedAt: game.agents.black.connectedAt } : null,
    },
    legalMoves: verboseMoves.map((move) => ({
      from: move.from,
      to: move.to,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion || ""}`,
      promotion: move.promotion || null,
    })),
    lastMove: game.history.at(-1) || null,
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

// ─── SSE broadcast ───────────────────────────────────────────────────────────

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
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

// ─── Agent detection & skill.md ──────────────────────────────────────────────

/**
 * Returns true when the request looks like it came from an agent/tool rather
 * than a browser. Browsers always send Accept: text/html and a Mozilla UA.
 */
function isAgentRequest(req) {
  const accept = req.headers["accept"] || "";
  const ua = req.headers["user-agent"] || "";
  return !accept.includes("text/html") || !ua.includes("Mozilla");
}

/**
 * Generates a dynamic skill.md document for the current game state.
 * Self-contained — the agent needs nothing else to start playing.
 * Purely factual — describes the world, does not prescribe moves.
 */
function generateSkillMd(req) {
  const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${req.headers.host}`;
  const s = slimState();
  const ctx = s.context;

  const whiteAgent = s.agents.white ? s.agents.white.name : "open seat";
  const blackAgent = s.agents.black ? s.agents.black.name : "open seat";
  const legalMovesList = s.legalMoves.map((m) => m.uci).join(", ") || "none — game is over";

  // Group promotion moves by their from-to square pair
  const promotionGroups = {};
  for (const p of ctx.promotionsAvailable) {
    const key = p.uci.slice(0, 4);
    if (!promotionGroups[key]) promotionGroups[key] = [];
    const names = { q: "queen", r: "rook", b: "bishop", n: "knight" };
    promotionGroups[key].push(`${p.uci} → ${names[p.piece]}(${PIECE_VALUES[p.piece]}pts)`);
  }

  const promotionSection = ctx.promotionsAvailable.length > 0
    ? [
        "",
        "## Pawn Promotion Available This Turn",
        "A pawn can reach the last rank. It MUST be transformed into another piece immediately.",
        "The UCI move includes a 5th character for the chosen piece: q=queen(9pts) r=rook(5pts) b=bishop(3pts) n=knight(3pts)",
        "All promotion variants are already listed in LEGAL MOVES above.",
        ...Object.entries(promotionGroups).map(([k, v]) => `- ${k.slice(0, 2)}→${k.slice(2, 4)}: ${v.join(" | ")}`),
        "",
      ].join("\n")
    : "";

  const attackLines = [
    `White pieces under attack by black: ${ctx.piecesUnderAttack.white.length > 0 ? ctx.piecesUnderAttack.white.map((e) => `${e.piece} on ${e.square}`).join(", ") : "none"}`,
    `Black pieces under attack by white: ${ctx.piecesUnderAttack.black.length > 0 ? ctx.piecesUnderAttack.black.map((e) => `${e.piece} on ${e.square}`).join(", ") : "none"}`,
  ].join("\n");

  const captureLines = ctx.capturesAvailable.length > 0
    ? ctx.capturesAvailable.map((c) => `- ${c.uci} (takes ${c.captures})`).join("\n")
    : "- none";

  const checkLines = ctx.checksAvailable.length > 0 ? ctx.checksAvailable.join(", ") : "none";

  return `# Agent Chess — Skill

You are an autonomous chess-playing agent. This document is your complete operating guide for this game session. Read it once, then follow the 3-step protocol.

---

## Current Board State

- **Game ID**: ${s.gameId}
- **FEN**: \`${s.fen}\`
- **Turn**: ${s.turn} to move
- **Status**: ${s.status}
- **Game over**: ${s.gameOver}
- **Phase**: ${ctx.phase}
- **Material — White**: ${ctx.whiteMaterial}pts | **Black**: ${ctx.blackMaterial}pts | **Balance**: ${ctx.materialBalance > 0 ? "+" : ""}${ctx.materialBalance} (positive = white ahead)
- **In check**: ${ctx.inCheck ? "YES — must resolve this turn. All listed legal moves are valid responses." : "no"}
- **White agent**: ${whiteAgent}
- **Black agent**: ${blackAgent}

## Board Narrative

${ctx.boardNarrative}

## Legal Moves (${s.legalMoves.length})

\`\`\`
${legalMovesList}
\`\`\`
${promotionSection}
## Pieces Under Attack

${attackLines}

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
- \`reason\` is stored with the move and visible in \`lastMove.reason\` on all subsequent events.

---

## Event JSON Schema

Each SSE event is a JSON object with the following fields:

| Field | Type | Description |
|---|---|---|
| \`gameId\` | string | Unique ID for this game session. If it changes, the game restarted — your token is invalid; exit. |
| \`fen\` | string | Complete board position in Forsyth-Edwards Notation. Encodes all board state. |
| \`turn\` | "white"/"black" | Whose turn it is to move. |
| \`status\` | string | "Playing.", "Check.", or end-of-game description. |
| \`gameOver\` | boolean | If true, stop playing and exit. |
| \`result\` | string/null | Populated when gameOver is true. |
| \`lastMove\` | object/null | The move just made: \`{ color, san, uci, from, to, reason }\` |
| \`agents\` | object | \`{ white, black }\` — each is \`{ name, connectedAt }\` or null if the seat is open. |
| \`legalMoves\` | array | All moves the current player may make this turn (see below). |
| \`context\` | object | Positional data computed for this turn (see below). |

### legalMoves entry fields

| Field | Description |
|---|---|
| \`uci\` | Move in UCI format: \`"e2e4"\` or \`"e7e8q"\` (5 characters when promotion) |
| \`san\` | Standard Algebraic Notation: \`"e4"\`, \`"Nf3"\`, \`"O-O"\`, \`"O-O-O"\` |
| \`from\` | Source square, e.g. \`"e2"\` |
| \`to\` | Destination square, e.g. \`"e4"\` |
| \`promotion\` | \`"q"\`/\`"r"\`/\`"b"\`/\`"n"\` or null — the piece chosen when a pawn promotes |

### context fields

| Field | Type | Description |
|---|---|---|
| \`phase\` | "opening"/"middlegame"/"endgame" | Derived from total pieces on board (32 at start) |
| \`materialBalance\` | number | White material minus black material in pawn units. Positive = white ahead. |
| \`whiteMaterial\` | number | White's total material value |
| \`blackMaterial\` | number | Black's total material value |
| \`inCheck\` | boolean | Current player is in check and must resolve it this turn |
| \`capturesAvailable\` | array | Current player's moves that capture a piece: \`[{ uci, captures }]\` |
| \`checksAvailable\` | string[] | UCI strings of moves that deliver check to the opponent |
| \`promotionsAvailable\` | array | Pawn promotion moves: \`[{ uci, piece }]\` |
| \`piecesUnderAttack\` | object | \`{ white: [{ square, piece }], black: [{ square, piece }] }\` — pieces attacked by the opponent right now |
| \`boardNarrative\` | string | Plain-English factual summary of the current position |

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
    from: String(input?.from || "").toLowerCase(),
    to: String(input?.to || "").toLowerCase(),
    promotion: input?.promotion ? String(input.promotion).toLowerCase() : undefined,
  };
}

function resetGame() {
  game.id = crypto.randomUUID();
  game.chess = new Chess();
  game.agents = { white: null, black: null };
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
    const extension = extname(requested);
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
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(await readFile(filePath));
}

// ─── Request router ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Serve skill.md to agents at GET /
    // Browsers send Accept: text/html — agents (curl, LLM tools, etc.) do not
    if (req.method === "GET" && url.pathname === "/" && isAgentRequest(req)) {
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(generateSkillMd(req));
      return;
    }

    // SSE event stream — main agent loop
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify(slimState())}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Join — returns full state (with history) once
    if (req.method === "POST" && url.pathname === "/api/join") {
      const body = await readJson(req);
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

    // Move — validates and applies the move
    if (req.method === "POST" && url.pathname === "/api/move") {
      const body = await readJson(req);
      const color = body.color === "black" ? "black" : "white";
      const agent = game.agents[color];
      if (!agent || agent.token !== body.token) return json(res, 403, { error: "agent token is invalid" });
      if (game.chess.isGameOver()) return json(res, 409, { error: "game is over", state: slimState() });
      if (game.chess.turn() !== colorToTurn(color)) return json(res, 409, { error: "not your turn", state: slimState() });

      const reason = body.reason ? String(body.reason).trim().slice(0, 1000) : null;
      if (!reason) return json(res, 400, { error: "reason is required — include a \"reason\" field explaining why you chose this move" });

      const result = game.chess.move(normalizeMove(body.move || body));
      if (!result) return json(res, 400, { error: "illegal move", state: slimState() });

      game.history.push({
        color,
        san: result.san,
        uci: `${result.from}${result.to}${result.promotion || ""}`,
        from: result.from,
        to: result.to,
        reason,
        at: new Date().toISOString(),
      });
      game.updatedAt = new Date().toISOString();
      broadcast();
      return json(res, 200, { ok: true, state: slimState() });
    }

    // Reset — human-only, not advertised to agents
    if (req.method === "POST" && url.pathname === "/api/reset") {
      resetGame();
      broadcast();
      return json(res, 200, { ok: true, state: slimState() });
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
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
