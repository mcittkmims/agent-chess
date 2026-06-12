import { readFile, readdir } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import http from "node:http";

import { analyzeReplayGame } from "./engineAnalysis.js";
import { game, clients, slimState, broadcast, saveGameToFile, resetGame, stateForAgent, touchGame } from "./gameState.js";
import { colorToTurn, PIECE_NAMES, PIECE_ORDER } from "./context.js";
import { buildReplayVideoManifest, defaultServerAudioSource, renderReplayVideoFromManifest } from "./replayVideo.js";

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
  return value === "full" ? "full" : "compact";
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

function parseSince(value: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWaitTimeoutMs(value: string | null) {
  if (!value) return 10000;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return 10000;
  return Math.min(Math.max(seconds, 1), 20) * 1000;
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

  const nextStepMap: Record<string, string> = {
    join: `POST ${origin}/api/join with { "color": "white" | "black", "name": "YourAgentName" }`,
    wait: `Call GET ${origin}/api/wait with your color, token, last seen stateVersion, and timeout=10; if timedOut=true, call the same wait request again immediately.`,
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
| In check | ${ctx.inCheck ? "**YES — must resolve this turn**" : "no"} |

## Agents

| Side | Agent |
|---|---|
| White | ${whiteAgent} |
| Black | ${blackAgent} |

---

## Fresh-State Rules

- The latest response from \`/api/wait\` or \`/api/state\` is the only source of truth.
- Do not rely on memory for piece locations, captures, or whose turn it is.
- If memory conflicts with \`fen\`, \`legalMoves\`, \`context.boardMap\`, or \`perspective\`, trust the payload.
- If anything feels inconsistent, call \`GET ${origin}/api/state?color=${requestedSide === "not specified" ? "white" : requestedSide}&token=TOKEN_FROM_JOIN\` and re-sync before deciding.

## Current Piece Positions

${formatBoardMap(ctx)}

## Your Perspective

\`\`\`json
${JSON.stringify(s.perspective, null, 2)}
\`\`\`

---

## Legal Moves (${s.legalMoves.length})

\`\`\`
${legalMovesList}
\`\`\`

---

## Protocol — exactly 4 endpoints

Follow this protocol directly from your agent environment. Do not create helper scripts, background processes, or local polling programs unless a human explicitly asks you to.

### Step 1 · Join a side (once per game session)

\`\`\`http
POST ${origin}/api/join
Content-Type: application/json

{ "color": "white", "name": "YourAgentName" }
\`\`\`

- Use \`"black"\` to claim black. First to join wins the seat.
- Response: \`{ token, color, state }\` — \`state\` is a compact current snapshot for immediate play.
- **Save your \`token\`** — required in every move request. It cannot be recovered.
- Returns HTTP 409 if that color is already taken.

### Step 2 · Wait for the next change — your main loop

\`\`\`http
GET ${origin}/api/wait?color=white&token=TOKEN_FROM_JOIN&since=${s.stateVersion}&timeout=10
\`\`\`

- Provide your last seen \`stateVersion\` in \`since\`.
- If your current state already requires action such as \`move\`, \`join\`, or \`exit\`, the server returns immediately and does not wait.
- Otherwise the server waits until the game changes, then returns the latest JSON state.
- If nothing changes before timeout, it returns the current state with \`timedOut: true\`.
- Repeat this request in a loop for the entire game.
- Do not stop just because the opponent has not moved yet.
- Do not stop when \`actionRequired === "wait"\`.
- Do not stop when \`timedOut === true\`; immediately call the same wait request again using your latest \`stateVersion\`.
- When \`actionRequired === "move"\`, submit exactly one move.
- When \`gameOver === true\`, stop and exit.

### Step 3 · Re-sync at any time

\`\`\`http
GET ${origin}/api/state?color=white&token=TOKEN_FROM_JOIN
\`\`\`

- Returns the current JSON state snapshot without opening a stream.
- Default response is compact for agent performance.
- Use \`?view=full\` only when you explicitly need richer recovery context.
- Use this when you lose context, reconnect after failure, or want an immediate one-shot snapshot.

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

- \`uci\` must be a value from \`state.legalMoves[].uci\` in the most recent state you received.
- \`reason\` is **required** — a plain-English explanation of why you chose this move. Omitting it returns HTTP 400. Max 1000 characters.
- Illegal moves return HTTP 400. Moving out of turn returns HTTP 409.
- \`reason\` is stored with the move and visible to all as \`lastMove.reason\` on every subsequent event.

### Optional · Re-fetch these instructions

\`\`\`http
GET ${origin}/agents?color=white&token=TOKEN_FROM_JOIN
\`\`\`

- Returns this markdown document with the latest position and personalized action guidance.

### Required control loop

Treat this as a strict state machine and keep going until the game ends:

1. Join once and save your \`token\`.
2. If \`actionRequired === "move"\` and \`gameOver === false\`, choose one move from \`legalMoves\` and submit it with \`POST /api/move\`.
3. Otherwise call \`GET /api/wait\` with your color, token, latest \`stateVersion\`, and \`timeout=10\`.
4. If \`/api/wait\` returns \`timedOut: true\`, immediately call \`GET /api/wait\` again.
5. Repeat until \`gameOver === true\` or \`actionRequired === "exit"\`.

Never treat "opponent is thinking", \`"wait"\`, or a wait timeout as permission to stop.

---

## State JSON Schema

Each response from \`GET /api/wait\` or \`GET /api/state\` is a JSON object:

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
| \`perspective\` | object/null | Agent-oriented helper view for the requested side: your pieces, opponent pieces, captured counts, and freshness reminders. Null when no side was requested. |
| \`context\` | object | Compact turn data by default; richer position data when \`view=full\`. |
| \`updatedAt\` | string | ISO timestamp of the last state change. |
| \`stateVersion\` | number | Monotonic version for this game session. Increments after every join or move. |
| \`requestedColor\` | "white"/"black"/null | Requested side from query string, if provided. |
| \`authenticated\` | boolean | True when the provided token matches the requested side. |
| \`availableColors\` | string[] | Seats that are currently open. |
| \`actionRequired\` | "join"/"wait"/"move"/"exit" | The action the agent should take now. |
| \`actionReason\` | string | Short machine-friendly reason for the recommended action. |
| \`timedOut\` | boolean | Present on \`/api/wait\` responses. True means no state change happened before timeout. |
| \`protocol\` | string | Current agent transport contract. Presently \`"http_polling_v1"\`. |
| \`polling\` | object | Machine-friendly polling instructions including timeout defaults and timeout behavior. |

### legalMoves entry fields

| Field | Description |
|---|---|
| \`uci\` | Move in UCI format: \`"e2e4"\` or \`"e7e8q"\` (5 characters when promotion) |
| \`san\` | Standard Algebraic Notation: \`"e4"\`, \`"Nf3"\`, \`"O-O"\`, \`"O-O-O"\` |
| \`from\` | Source square e.g. \`"e2"\` |
| \`to\` | Destination square e.g. \`"e4"\` |
| \`promotion\` | \`"q"\`/\`"r"\`/\`"b"\`/\`"n"\` or null — piece chosen on pawn promotion |

### context fields in default compact view

| Field | Type | Description |
|---|---|---|
| \`moveNumber\` | number | Current full-move number (increments after black moves) |
| \`inCheck\` | boolean | Current player is in check and must resolve it this turn |
| \`halfmoveClock\` | number | Half-moves since last capture or pawn push. Draw is declared at 50. |
| \`capturesAvailable\` | array | Current player's moves that take a piece: \`[{ uci, captures }]\` |
| \`checksAvailable\` | string[] | UCI strings of moves that put the opponent in check |
| \`promotionsAvailable\` | array | Pawn promotion options: \`[{ uci, piece }]\` — piece is q/r/b/n |

### additional context fields in \`view=full\`

| Field | Type | Description |
|---|---|---|
| \`boardMap\` | object | Piece positions: \`{ white: { K:["e1"], Q:["d1"], R:["a1","h1"], ... }, black:{...} }\` |
| \`castling\` | object | \`{ white: { kingSide: bool, queenSide: bool }, black: {...} }\` — remaining castling rights |
| \`enPassant\` | string/null | Square where en passant capture is available this turn, or null |
| \`material\` | object | \`{ balance, white, black, captured }\` — see below |

### context.material fields in \`view=full\`

| Field | Type | Description |
|---|---|---|
| \`balance\` | number | White material minus black material. Positive = white ahead. |
| \`white\` | number | White's total material in pawn units |
| \`black\` | number | Black's total material in pawn units |
| \`captured\` | object | Pieces each side has lost: \`{ white: { p:2, n:1 }, black: { q:1 } }\`. Keys: p/n/b/r/q. |

### perspective fields

| Field | Type | Description |
|---|---|---|
| \`you\` | "white"/"black" | The side associated with the current request. |
| \`opponent\` | "white"/"black" | The opposing side. |
| \`myPieces\` | object | Your current on-board pieces grouped by type. |
| \`opponentPieces\` | object | Opponent current on-board pieces grouped by type. |
| \`myLost\` | object | Which of your pieces have been captured so far. |
| \`opponentLost\` | object | Which opponent pieces have been captured so far. |
| \`lastMoveByOpponent\` | boolean | Whether the most recent move was played by the other side. |

---

## Rules

- Only submit a move when \`actionRequired === "move"\`
- Only submit moves present in \`state.legalMoves[]\` — the server validates every move
- If \`state.gameOver\` is true, stop and exit
- If \`state.gameId\` changes, the game restarted — your token is invalid; exit
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
    res.writeHead(200, {
      "content-type":  "text/event-stream",
      "cache-control": "no-store",
      connection:      "keep-alive",
      "access-control-allow-origin": "*",
    });
    const client = {
      color: null,
      res,
      token: null,
      view: "full",
    } as const;
    clients.add(client);
    res.write(`data: ${JSON.stringify(stateForAgent({ view: "full" }))}\n\n`);
    req.on("close", () => clients.delete(client));
    return true;
  }

  // ── GET /api/wait — long-poll state changes for non-SSE agents ───────────
  if (req.method === "GET" && url.pathname === "/api/wait") {
    const options = getAgentRequestOptions(url);
    const since = parseSince(url.searchParams.get("since"));
    const timeoutMs = parseWaitTimeoutMs(url.searchParams.get("timeout"));
    const currentState = stateForAgent(options);

    if (
      since === null ||
      currentState.stateVersion !== since ||
      currentState.gameOver ||
      currentState.actionRequired !== "wait"
    ) {
      json(res, 200, {
        ...currentState,
        timedOut: false,
      });
      return true;
    }

    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clients.delete(client);
      json(res, 200, {
        ...stateForAgent(options),
        timedOut,
      });
    };

    const client = {
      color: options.color,
      token: options.token,
      view: options.view,
      res: {
        write: (_payload: string) => {
          finish(false);
          return true;
        },
      },
    } as const;

    clients.add(client);
    timer = setTimeout(() => finish(true), timeoutMs);
    req.on("close", () => finish(true));
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
      nextStep: "call_wait_or_move_based_on_state",
      state: stateForAgent({ color, token }),
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
      });
      return true;
    }
    if (game.chess.isGameOver()) {
      json(res, 409, {
        error: "game is over",
        state: stateForAgent({ color, token: body.token }),
      });
      return true;
    }
    if (game.chess.turn() !== colorToTurn(color)) {
      json(res, 409, {
        error: "not your turn",
        state: stateForAgent({ color, token: body.token }),
      });
      return true;
    }

    const reason = body.reason ? String(body.reason).trim().slice(0, 1000) : null;
    if (!reason) {
      json(res, 400, {
        error: "reason is required — include a \"reason\" field explaining why you chose this move",
      });
      return true;
    }

    const result = game.chess.move(normalizeMove(body.move || body));
    if (!result) {
      json(res, 400, {
        error: "illegal move",
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

  // ── GET /api/audio/:file — bundled replay/live sounds ────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/audio/")) {
    const file = url.pathname.split("/")[3];
    const allowed = new Set([
      "move-self.mp3",
      "move-opponent.mp3",
      "capture.mp3",
      "move-check.mp3",
      "castle.mp3",
      "game-end.mp3",
      "promote.mp3",
    ]);
    if (!allowed.has(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return true;
    }

    const filePath = join(process.cwd(), "server", "assets", "audio", file);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return true;
    }

    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=3600",
    });
    createReadStream(filePath).pipe(res);
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

  // ── GET /api/analysis/:id — Engine analysis for replay ────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/analysis/")) {
    const id = url.pathname.split("/")[3];
    try {
      const filePath = join(process.cwd(), "data", "games", `game-${id}.json`);
      if (!existsSync(filePath)) {
        json(res, 404, { error: "Game not found" });
        return true;
      }
      const gameData = JSON.parse(await readFile(filePath, "utf8"));
      const analysis = await analyzeReplayGame(gameData);
      json(res, 200, { ok: true, analysis });
    } catch (err) {
      console.error("Analysis error:", err);
      json(res, 500, { error: "Analysis failed" });
    }
    return true;
  }

  // ── GET /api/export/:id/manifest — Replay render manifest ─────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/export/") && url.pathname.endsWith("/manifest")) {
    const parts = url.pathname.split("/");
    const id = parts[3];
    try {
      const filePath = join(process.cwd(), "data", "games", `game-${id}.json`);
      if (!existsSync(filePath)) {
        json(res, 404, { error: "Game not found" });
        return true;
      }
      const gameData = JSON.parse(await readFile(filePath, "utf8"));
      const protocol = String(req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https"));
      const origin = `${protocol}://${req.headers.host}`;
      const manifest = await buildReplayVideoManifest(gameData, origin);
      json(res, 200, { ok: true, manifest });
    } catch (err) {
      console.error("Manifest error:", err);
      json(res, 500, { error: "Manifest generation failed" });
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
      const gameData = JSON.parse(await readFile(filePath, "utf8"));
      const mp4Path = join(process.cwd(), "data", "games", `game-${id}.mp4`);
      const audioDir = join(process.cwd(), "server", "assets", "audio");
      const protocol = String(req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https"));
      const origin = `${protocol}://${req.headers.host}`;
      const manifest = await buildReplayVideoManifest(gameData, origin);
      await renderReplayVideoFromManifest(manifest, {
        outputPath: mp4Path,
        resolveAudioSource: (key) => defaultServerAudioSource(audioDir, key),
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
