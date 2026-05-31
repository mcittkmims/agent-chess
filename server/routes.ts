import { readFile, readdir } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import sharp from "sharp";
import { Chess } from "chess.js";

import { game, clients, slimState, fullState, broadcast, saveGameToFile, resetGame } from "./gameState.js";
import { generateFrameSvg } from "./svgRenderer.js";
import { colorToTurn, PIECE_NAMES, PIECE_ORDER } from "./context.js";

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function readJson(req: http.IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function json(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, {
    "content-type":  "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function normalizeMove(input: any) {
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

function isAgentRequest(req: http.IncomingMessage) {
  const accept = req.headers["accept"] || "";
  const ua     = req.headers["user-agent"] || "";
  if (accept.includes("text/markdown")) return true;
  if (accept.includes("text/html")) return false;
  return !ua.toLowerCase().includes("mozilla");
}

function formatBoardMap(ctx: any) {
  const fmt = (side: string) => {
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

function generateSkillMd(req: http.IncomingMessage) {
  const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https");
  const origin   = `${protocol}://${req.headers.host}`;
  const s   = slimState();
  const ctx = s.context;
  const mat = ctx.material;

  const whiteAgent = s.agents.white ? s.agents.white.name : "open seat";
  const blackAgent = s.agents.black ? s.agents.black.name : "open seat";

  const legalMovesList = s.legalMoves.map((m: any) => m.uci).join(", ") || "none — game is over";

  const promotionGroups: Record<string, string[]> = {};
  for (const p of ctx.promotionsAvailable) {
    const key = p.uci.slice(0, 4);
    if (!promotionGroups[key]) promotionGroups[key] = [];
    const names: Record<string, string> = { q: "queen(9pts)", r: "rook(5pts)", b: "bishop(3pts)", n: "knight(3pts)" };
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

  const castFmt = (side: string) => {
    const c = ctx.castling[side as 'white' | 'black'];
    return `kingside: ${c.kingSide ? "yes" : "no"}, queenside: ${c.queenSide ? "yes" : "no"}`;
  };

  const wCap = Object.entries(mat.captured.white).map(([t, n]) => `${n}×${t}`).join(", ") || "none";
  const bCap = Object.entries(mat.captured.black).map(([t, n]) => `${n}×${t}`).join(", ") || "none";

  const fmtAttack = (list: any[]) => list.length > 0
    ? list.map((e) => `${e.piece} on ${e.square}`).join(", ")
    : "none";

  const captureLines = ctx.capturesAvailable.length > 0
    ? ctx.capturesAvailable.map((c: any) => `- ${c.uci} (takes ${c.captures})`).join("\n")
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


export async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  // ── GET / — skill.md for agents ──────────────────────────────────────────
  if (req.method === "GET" && (url.pathname === "/agents" || (url.pathname === "/" && isAgentRequest(req)))) {
    res.writeHead(200, {
      "content-type":  "text/markdown; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(generateSkillMd(req));
    return true;
  }

  // ── GET /api/events — SSE stream (main agent loop) ───────────────────────
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type":  "text/event-stream",
      "cache-control": "no-store",
      connection:      "keep-alive",
      "access-control-allow-origin": "*",
    });
    clients.add(res as any);
    res.write(`data: ${JSON.stringify(slimState())}\n\n`);
    req.on("close", () => clients.delete(res as any));
    return true;
  }

  // ── POST /api/join — claim a side ────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/join") {
    const body  = await readJson(req);
    const color = body.color === "black" ? "black" : "white";
    if (game.agents[color]) {
      json(res, 409, { error: `${color} is already taken` });
      return true;
    }
    const token = crypto.randomUUID();
    game.agents[color] = {
      token,
      name: String(body.name || `${color} agent`).slice(0, 60),
      connectedAt: new Date().toISOString(),
    };
    game.updatedAt = new Date().toISOString();
    broadcast();
    json(res, 200, { token, color, state: fullState() });
    return true;
  }

  // ── POST /api/move — validate and apply a move ───────────────────────────
  if (req.method === "POST" && url.pathname === "/api/move") {
    const body  = await readJson(req);
    const color = body.color === "black" ? "black" : "white";
    const agent = game.agents[color];

    if (!agent || agent.token !== body.token) {
      json(res, 403, { error: "agent token is invalid" });
      return true;
    }
    if (game.chess.isGameOver()) {
      json(res, 409, { error: "game is over", state: slimState() });
      return true;
    }
    if (game.chess.turn() !== colorToTurn(color)) {
      json(res, 409, { error: "not your turn", state: slimState() });
      return true;
    }

    const reason = body.reason ? String(body.reason).trim().slice(0, 1000) : null;
    if (!reason) {
      json(res, 400, { error: "reason is required — include a \"reason\" field explaining why you chose this move" });
      return true;
    }

    const result = game.chess.move(normalizeMove(body.move || body));
    if (!result) {
      json(res, 400, { error: "illegal move", state: slimState() });
      return true;
    }

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
    
    if (game.chess.isGameOver()) {
      saveGameToFile();
    }

    json(res, 200, { ok: true, state: slimState() });
    return true;
  }

  // ── POST /api/reset — human-only ─────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/reset") {
    resetGame();
    broadcast();
    json(res, 200, { ok: true, state: slimState() });
    return true;
  }

  // ── GET /api/games — List all saved games ─────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/games") {
    try {
      const gamesDir = join(process.cwd(), "data", "games");
      if (!existsSync(gamesDir)) {
        json(res, 200, { ok: true, games: [] });
        return true;
      }
      const files = await readdir(gamesDir);
      const games = [];
      for (const file of files) {
        if (file.endsWith(".json")) {
          const data = await readFile(join(gamesDir, file), "utf8");
          const parsed = JSON.parse(data);
          games.push({
            gameId: parsed.gameId,
            agents: parsed.agents,
            result: parsed.result,
            updatedAt: parsed.updatedAt
          });
        }
      }
      games.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      json(res, 200, { ok: true, games });
    } catch (err) {
      json(res, 500, { error: "Failed to read games" });
    }
    return true;
  }

  // ── GET /api/games/:id — Fetch specific game ──────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/games/")) {
    const id = url.pathname.split("/")[3];
    try {
      const filePath = join(process.cwd(), "data", "games", `game-${id}.json`);
      if (!existsSync(filePath)) {
        json(res, 404, { error: "Game not found" });
        return true;
      }
      const data = await readFile(filePath, "utf8");
      json(res, 200, { ok: true, game: JSON.parse(data) });
    } catch (err) {
      json(res, 500, { error: "Failed to read game" });
    }
    return true;
  }

  // ── POST /api/export/:id — Export MP4 ─────────────────────────────────
  if (req.method === "POST" && url.pathname.startsWith("/api/export/")) {
    const id = url.pathname.split("/")[3];
    try {
      const filePath = join(process.cwd(), "data", "games", `game-${id}.json`);
      if (!existsSync(filePath)) {
        json(res, 404, { error: "Game not found" });
        return true;
      }
      const gameDataStr = await readFile(filePath, "utf8");
      const gameData = JSON.parse(gameDataStr);

      const mp4Path = join(process.cwd(), "data", "games", `game-${id}.mp4`);

      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-f", "image2pipe",
        "-vcodec", "png",
        "-r", "2",
        "-i", "-",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        mp4Path
      ]);

      const chess = new Chess();
      const moves = gameData.history;
      
      let svg = generateFrameSvg(chess.fen(), null, null);
      let pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
      ffmpeg.stdin.write(pngBuffer);
      
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        chess.move(move.uci);
        const reasonText = `${move.color === "white" ? "White" : "Black"} (${move.san}): ${move.reason}`;
        svg = generateFrameSvg(chess.fen(), move, reasonText);
        pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
        ffmpeg.stdin.write(pngBuffer);
      }
      
      ffmpeg.stdin.write(pngBuffer);
      ffmpeg.stdin.end();

      await new Promise<void>((resolve, reject) => {
        ffmpeg.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error("ffmpeg exit code " + code));
        });
        ffmpeg.on("error", reject);
      });

      json(res, 200, { ok: true, url: `/api/downloads/${id}.mp4` });
    } catch (err) {
      console.error("Export error:", err);
      json(res, 500, { error: "Export failed" });
    }
    return true;
  }

  // ── GET /api/downloads/:id.mp4 ────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/downloads/")) {
    const file = url.pathname.split("/")[3];
    const filePath = join(process.cwd(), "data", "games", `game-${file}`);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return true;
    }
    res.writeHead(200, { "content-type": "video/mp4" });
    const stream = createReadStream(filePath);
    stream.pipe(res);
    return true;
  }

  return false;
}
