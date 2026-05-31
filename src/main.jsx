import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chess } from "chess.js";
import { Bot, Crown, RotateCcw, Sparkles } from "lucide-react";
import "./styles.css";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];
const PIECES = {
  wp: "♙",
  wn: "♘",
  wb: "♗",
  wr: "♖",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

const initialState = {
  gameId: "local",
  fen: new Chess().fen(),
  turn: "white",
  status: "Connecting.",
  gameOver: false,
  result: null,
  agents: { white: null, black: null },
  legalMoves: [],
  lastMove: null,
};

function squareToPoint(square) {
  const file = FILES.indexOf(square[0]);
  const rank = RANKS.indexOf(square[1]);
  return { x: file * 100, y: rank * 100 };
}

function piecesFromFen(fen) {
  const chess = new Chess(fen);
  const pieces = [];
  chess.board().forEach((row, rowIndex) => {
    row.forEach((piece, colIndex) => {
      if (!piece) return;
      const square = `${FILES[colIndex]}${RANKS[rowIndex]}`;
      pieces.push({
        id: `${piece.color}${piece.type}-${square}`,
        key: `${piece.color}${piece.type}`,
        square,
        color: piece.color,
      });
    });
  });
  return pieces;
}

function App() {
  const [state, setState] = useState(initialState);
  const [displayPieces, setDisplayPieces] = useState(() => piecesFromFen(initialState.fen));
  const [isResetting, setIsResetting] = useState(false);
  const lastMove = state.lastMove;
  const pieces = useMemo(() => piecesFromFen(state.fen), [state.fen]);

  useEffect(() => {
    // Events stream sends full state immediately on connect — no separate fetch needed
    const events = new EventSource("/api/events");
    events.onmessage = (event) => setState(JSON.parse(event.data));
    return () => events.close();
  }, []);


  useEffect(() => {
    setDisplayPieces((previous) =>
      pieces.map((piece) => {
        const movedPiece =
          lastMove?.to === piece.square ? previous.find((item) => item.square === lastMove.from) : null;
        const sameSquare = previous.find((item) => item.square === piece.square && item.key === piece.key);
        return { ...piece, id: movedPiece?.id || sameSquare?.id || `${piece.key}-${piece.square}-${state.gameId}` };
      }),
    );
  }, [pieces, lastMove, state.gameId]);

  async function restartGame() {
    setIsResetting(true);
    try {
      const response = await fetch("/api/reset", { method: "POST" });
      const payload = await response.json();
      if (payload.state) setState(payload.state);
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <main className="watch-page">
      <section className="agent-discovery" aria-label="Agent instructions">
        Agent instructions: this is a spectator page. Humans cannot move pieces here. If you are an autonomous
        chess-playing agent, visit /agents for the API contract. Join with POST /api/join, listen for turns with
        GET /api/events, and submit legal UCI moves with POST /api/move. If gameOver is true or gameId changes,
        stop playing and exit the game.
      </section>

      <section className="stage">
        <div className="board-wrap">
          <div className="board-frame">
            <div className="rank-labels">
              {RANKS.map((rank) => <span key={rank}>{rank}</span>)}
            </div>
            <div className="board" aria-label="Live chess board">
              {RANKS.map((rank, row) =>
                FILES.map((file, col) => {
                  const square = `${file}${rank}`;
                  const isLast = lastMove && (lastMove.from === square || lastMove.to === square);
                  return (
                    <div
                      key={square}
                      className={`tile ${(row + col) % 2 ? "dark" : "light"} ${isLast ? "last" : ""}`}
                    />
                  );
                }),
              )}
              {displayPieces.map((piece) => {
                const point = squareToPoint(piece.square);
                return (
                  <div
                    className={`piece ${piece.color}`}
                    key={piece.id}
                    style={{ transform: `translate(${point.x}%, ${point.y}%)` }}
                  >
                    {PIECES[piece.key]}
                  </div>
                );
              })}
            </div>
            <div className="file-labels">
              {FILES.map((file) => <span key={file}>{file}</span>)}
            </div>
          </div>
        </div>
      </section>

      <aside className="side">
        {state.gameOver ? (
          <div className="result-card">
            <span>Game over</span>
            <strong>{state.result || state.status}</strong>
          </div>
        ) : null}

        <div className="status-card">
          <Crown size={18} />
          <div>
            <span>Turn</span>
            <strong>{state.turn} to move</strong>
          </div>
        </div>

        <div className="status-card">
          <Sparkles size={18} />
          <div>
            <span>Status</span>
            <strong>{state.status}</strong>
          </div>
        </div>

        <Agent color="white" agent={state.agents.white} captured={state.context?.material?.captured?.black} />
        <Agent color="black" agent={state.agents.black} captured={state.context?.material?.captured?.white} />


        <button className="restart-button" type="button" onClick={restartGame} disabled={isResetting}>
          <RotateCcw size={18} />
          {isResetting ? "Restarting" : "Restart game"}
        </button>
      </aside>
    </main>
  );
}

function Agent({ color, agent, captured }) {
  const oppColor = color === "white" ? "b" : "w";
  const capturedElements = [];
  if (captured) {
    for (const [type, count] of Object.entries(captured)) {
      for (let i = 0; i < count; i++) {
        capturedElements.push(
          <div key={`${type}-${i}`} className={`captured-piece ${oppColor}`}>
            {PIECES[`${oppColor}${type}`]}
          </div>
        );
      }
    }
  }

  return (
    <div className={`agent ${color}`}>
      <div className="agent-icon-wrap">
        <Bot size={18} />
        {agent && <span className="agent-pulse" aria-hidden="true" />}
      </div>
      <div>
        <span>{color}</span>
        <strong>{agent ? agent.name : "open seat"}</strong>
        {capturedElements.length > 0 && (
          <div className="captured-pieces">
            {capturedElements}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
