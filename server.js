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
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function colorToTurn(color) {
  return color === "white" ? "w" : "b";
}

function state() {
  return {
    gameId: game.id,
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? "white" : "black",
    status: status(),
    agents: {
      white: game.agents.white ? { name: game.agents.white.name, connectedAt: game.agents.white.connectedAt } : null,
      black: game.agents.black ? { name: game.agents.black.name, connectedAt: game.agents.black.connectedAt } : null,
    },
    legalMoves: game.chess.moves({ verbose: true }).map((move) => ({
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
  });
  res.end(JSON.stringify(body));
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
  game.history = [];
  game.updatedAt = new Date().toISOString();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
  res.end(await readFile(filePath));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

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
      const body = await readJson(req);
      if (!process.env.ADMIN_KEY) return json(res, 404, { error: "reset is disabled" });
      if (body.key !== process.env.ADMIN_KEY) return json(res, 403, { error: "invalid admin key" });
      resetGame();
      broadcast();
      return json(res, 200, state());
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
