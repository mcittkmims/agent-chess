import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chess } from "chess.js";
import { Bot, Crown, Sparkles } from "lucide-react";
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
  agents: { white: null, black: null },
  legalMoves: [],
  history: [],
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
  const lastMove = state.history.at(-1);
  const pieces = useMemo(() => piecesFromFen(state.fen), [state.fen]);

  useEffect(() => {
    fetch("/api/state")
      .then((response) => response.json())
      .then(setState)
      .catch(() => {});

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

  return (
    <main className="watch-page">
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

        <Agent color="white" agent={state.agents.white} />
        <Agent color="black" agent={state.agents.black} />

        <div className="moves">
          <h2>Moves</h2>
          {state.history.length ? (
            <div className="move-list">
              {state.history.map((move, index) => (
                <p key={`${move.uci}-${index}`}>
                  <span>{index + 1}</span>
                  <b>{move.color}</b>
                  <strong>{move.san}</strong>
                </p>
              ))}
            </div>
          ) : (
            <p className="empty">Waiting for the first agent move.</p>
          )}
        </div>

        <div className="contract">
          <h2>Agent endpoints</h2>
          <code>POST /api/join</code>
          <code>POST /api/move</code>
        </div>
      </aside>
    </main>
  );
}

function Agent({ color, agent }) {
  return (
    <div className={`agent ${color}`}>
      <Bot size={18} />
      <div>
        <span>{color}</span>
        <strong>{agent ? agent.name : "open seat"}</strong>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
