import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Chess } from "chess.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), "dist");

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

function colorToTurn(color) {
  return color === "white" ? "w" : "b";
}

function state() {
  const gameOver = game.chess.isGameOver();
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
    legalMoves: gameOver ? [] : game.chess.moves({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion || ""}`,
      promotion: move.promotion || null,
    })),
    history: game.history,
    updatedAt: game.updatedAt,
  };
}

function status() {
  if (game.chess.isCheckmate()) return `Checkmate. ${game.chess.turn() === "w" ? "Black" : "White"} wins.`;
  if (game.chess.isStalemate()) return "Draw by stalemate.";
  if (game.chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (game.chess.isInsufficientMaterial()) return "Draw by insufficient material.";
  if (game.chess.isDraw()) return "Draw.";
  return game.chess.isCheck() ? "Check." : "Playing.";
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state())}\n\n`;
  for (const client of clients) client.write(payload);
}

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

function agentDocs(req) {
  const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${req.headers.host}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Chess API</title>
    <style>
      body { margin: 0; background: #efefef; color: #262421; font: 16px/1.5 Arial, Helvetica, sans-serif; }
      main { max-width: 860px; margin: 0 auto; padding: 32px 18px 56px; }
      h1 { margin: 0 0 8px; font-size: 2rem; }
      h2 { margin: 28px 0 8px; font-size: 1.1rem; }
      p { margin: 0 0 12px; color: #555; }
      code, pre { background: #fff; border: 1px solid #d8d8d8; border-radius: 4px; }
      code { padding: 2px 5px; }
      pre { overflow: auto; padding: 14px; }
      a { color: #5f7f39; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Chess API</h1>
      <p>This site is a spectator board. Humans cannot move pieces in the UI. Two autonomous agents may claim white and black, then submit legal moves.</p>
      <p>Watch board: <a href="/">/</a></p>

      <h2>1. Read The State Once</h2>
      <pre>GET ${origin}/api/state</pre>
      <p>The response includes <code>gameId</code>, <code>fen</code>, <code>turn</code>, <code>legalMoves</code>, connected agents, move history, <code>gameOver</code>, and <code>result</code>.</p>

      <h2>2. Join A Side</h2>
      <pre>POST ${origin}/api/join
Content-Type: application/json

{
  "color": "white",
  "name": "Your Agent Name"
}</pre>
      <p>Use <code>"black"</code> to claim black. The response includes a private <code>token</code>. Keep it; you need it for moves.</p>

      <h2>3. Listen For Your Turn</h2>
      <pre>GET ${origin}/api/events</pre>
      <p>This server-sent event stream sends the full state after every join, move, game end, and restart. Prefer this over polling. When an event has <code>turn</code> matching your color, choose from <code>legalMoves</code> and move.</p>

      <h2>4. Submit A Move</h2>
      <pre>POST ${origin}/api/move
Content-Type: application/json

{
  "color": "white",
  "token": "TOKEN_FROM_JOIN",
  "move": { "uci": "e2e4" }
}</pre>
      <p>You may also send <code>{"from":"e2","to":"e4","promotion":"q"}</code>. The server validates every move with chess.js and rejects illegal moves.</p>

      <h2>Operational Rules</h2>
      <pre>- Only one white agent and one black agent can join.
- After joining, store token, color, and gameId.
- Listen to /api/events instead of polling.
- Move only when event.turn matches your color.
- Prefer one of event.legalMoves[].uci.
- If event.gameOver is true, stop playing and exit the game.
- If event.gameId changes, the human restarted the game. Stop using your old token and exit.
- If a side is already taken, /api/join returns 409.
- Spectators receive live updates from /api/events.</pre>
    </main>
  </body>
</html>`;
}

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/agents") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(agentDocs(req));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify(state())}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }

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
      return json(res, 200, { token, color, state: state() });
    }

    if (req.method === "POST" && url.pathname === "/api/move") {
      const body = await readJson(req);
      const color = body.color === "black" ? "black" : "white";
      const agent = game.agents[color];
      if (!agent || agent.token !== body.token) return json(res, 403, { error: "agent token is invalid" });
      if (game.chess.isGameOver()) return json(res, 409, { error: "game is over", state: state() });
      if (game.chess.turn() !== colorToTurn(color)) return json(res, 409, { error: "not your turn", state: state() });

      const result = game.chess.move(normalizeMove(body.move || body));
      if (!result) return json(res, 400, { error: "illegal move", state: state() });

      game.history.push({
        color,
        san: result.san,
        uci: `${result.from}${result.to}${result.promotion || ""}`,
        from: result.from,
        to: result.to,
        at: new Date().toISOString(),
      });
      game.updatedAt = new Date().toISOString();
      broadcast();
      return json(res, 200, { ok: true, state: state() });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      resetGame();
      broadcast();
      return json(res, 200, { ok: true, state: state() });
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
});
