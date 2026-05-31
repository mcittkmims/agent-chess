import { readFile, readdir } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import sharp from "sharp";
import { Chess } from "chess.js";

import { game, clients, slimState, fullState, broadcast, saveGameToFile, resetGame, stateForAgent, touchGame } from "./gameState.js";
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

function parseColor(value: string | null) {
  if (value === "white" || value === "black") return value;
  return null;
}

function parseView(value: string | null) {
  return value === "compact" ? "compact" : "full";
}

function getAgentRequestOptions(url: URL) {
  return {
    color: parseColor(url.searchParams.get("color")),
    token: url.searchParams.get("token"),
    view: parseView(url.searchParams.get("view")),
  } as {
    color: "white" | "black" | null;
    token: string | null;
    view: "compact" | "full";
  };
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

function generateSkillMd(req: http.IncomingMessage, url: URL) {
  const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https");
  const origin   = `${protocol}://${req.headers.host}`;
  const requestOptions = getAgentRequestOptions(url);
  const s   = stateForAgent({ ...requestOptions, view: "full" });
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

  const nextStepMap: Record<string, string> = {
    join: `POST ${origin}/api/join with { "color": "white" | "black", "name": "YourAgentName" }`,
    wait: `Keep GET ${origin}/api/events open and wait for the next event.`,
    move: `POST ${origin}/api/move with one legal UCI move, your saved token, and a short reason.`,
    exit: "Stop playing. The current game is finished.",
  };

  const requestedSide = s.requestedColor || "not specified";
  const authText = s.requestedColor ? (s.authenticated ? "yes" : "no") : "n/a";
  const openSeats = s.availableColors.length > 0 ? s.availableColors.join(", ") : "none";

  return `# Agent Chess — Skill

You are an autonomous chess-playing agent. Use the explicit agent endpoints below. The human spectator UI at \`/\` is not part of the agent protocol.

## Operate Now

| Field | Value |
|---|---|
| Requested side | ${requestedSide} |
| Authenticated | ${authText} |
| Open seats | ${openSeats} |
| Turn | **${s.turn}** |
| Game over | ${s.gameOver} |
| Action required | **${s.actionRequired}** |
| Action reason | ${s.actionReason} |
| Recommended action | ${s.recommendedAction} |
| Next step | ${nextStepMap[s.actionRequired]} |

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

## Protocol — exactly 4 endpoints

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
GET ${origin}/api/events?color=white&token=TOKEN_FROM_JOIN
\`\`\`

- Server-Sent Events stream. Keep this connection open for the duration of the game.
- Sends a complete state object immediately on connect, then after every game event.
- When \`color\` and \`token\` are included in the query string, each event includes personalized fields: \`actionRequired\`, \`actionReason\`, \`recommendedAction\`, and \`authenticated\`.
- Each event is fully self-sufficient — you do not need move history to decide your next move.
- When \`actionRequired === "move"\` → submit a move.

### Step 3 · Re-sync at any time

\`\`\`http
GET ${origin}/api/state?color=white&token=TOKEN_FROM_JOIN
\`\`\`

- Returns the current JSON state snapshot without opening a stream.
- Supports \`?view=compact\` for a smaller recovery payload.
- Use this when you lose context, reconnect after failure, or want a one-shot snapshot.

### Step 4 · Submit a move

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

### Optional · Re-fetch these instructions

\`\`\`http
GET ${origin}/agents?color=white&token=TOKEN_FROM_JOIN
\`\`\`

- Returns this markdown document with the latest position and personalized action guidance.

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
| \`stateVersion\` | number | Monotonic version for this game session. Increments after every join or move. |
| \`requestedColor\` | "white"/"black"/null | Requested side from query string, if provided. |
| \`authenticated\` | boolean | True when the provided token matches the requested side. |
| \`availableColors\` | string[] | Seats that are currently open. |
| \`actionRequired\` | "join"/"wait"/"move"/"exit" | The action the agent should take now. |
| \`actionReason\` | string | Short machine-friendly reason for the recommended action. |
| \`recommendedAction\` | string | Recovery hint or next-step hint. |

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

- Only submit a move when \`actionRequired === "move"\`
- Only submit moves present in \`event.legalMoves[]\` — the server validates every move
- If \`event.gameOver\` is true, stop and exit
- If \`event.gameId\` changes, the game restarted — your token is invalid; exit
- Only one agent per color; HTTP 409 on join means that seat is taken
`;
}


export async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  // ── GET /agents — explicit agent docs ─────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/agents") {
    res.writeHead(200, {
      "content-type":  "text/markdown; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(generateSkillMd(req, url));
    return true;
  }

  // ── GET /api/state — one-shot state snapshot ─────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, 200, stateForAgent(getAgentRequestOptions(url)));
    return true;
  }

  // ── GET /api/events — SSE stream (main agent loop) ───────────────────────
  if (req.method === "GET" && url.pathname === "/api/events") {
    const options = getAgentRequestOptions(url);
    res.writeHead(200, {
      "content-type":  "text/event-stream",
      "cache-control": "no-store",
      connection:      "keep-alive",
      "access-control-allow-origin": "*",
    });
    const client = {
      color: options.color,
      res,
      token: options.token,
      view: options.view,
    } as const;
    clients.add(client);
    res.write(`data: ${JSON.stringify(stateForAgent(options))}\n\n`);
    req.on("close", () => clients.delete(client));
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
    touchGame();
    broadcast();
    json(res, 200, {
      token,
      color,
      seatConfirmed: true,
      tokenExpiresOnReset: true,
      nextStep: "connect_events",
      state: stateForAgent({ color, includeHistory: true, token }),
    });
    return true;
  }

  // ── POST /api/move — validate and apply a move ───────────────────────────
  if (req.method === "POST" && url.pathname === "/api/move") {
    const body  = await readJson(req);
    const color = body.color === "black" ? "black" : "white";
    const agent = game.agents[color];

    if (!agent || agent.token !== body.token) {
      json(res, 403, {
        error: "agent token is invalid",
        recommendedAction: "rejoin_if_game_restarted_or_wait_for_reset",
      });
      return true;
    }
    if (game.chess.isGameOver()) {
      json(res, 409, {
        error: "game is over",
        recommendedAction: "exit",
        state: stateForAgent({ color, token: body.token }),
      });
      return true;
    }
    if (game.chess.turn() !== colorToTurn(color)) {
      json(res, 409, {
        error: "not your turn",
        recommendedAction: "wait_for_next_event",
        state: stateForAgent({ color, token: body.token }),
      });
      return true;
    }

    const reason = body.reason ? String(body.reason).trim().slice(0, 1000) : null;
    if (!reason) {
      json(res, 400, {
        error: "reason is required — include a \"reason\" field explaining why you chose this move",
        recommendedAction: "resubmit_with_reason",
      });
      return true;
    }

    const result = game.chess.move(normalizeMove(body.move || body));
    if (!result) {
      json(res, 400, {
        error: "illegal move",
        recommendedAction: "choose_a_move_from_legalMoves",
        state: stateForAgent({ color, token: body.token }),
      });
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
    touchGame();
    broadcast();
    
    if (game.chess.isGameOver()) {
      saveGameToFile();
    }

    json(res, 200, { ok: true, state: stateForAgent({ color, token: body.token }) });
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
