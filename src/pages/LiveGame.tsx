import React, { useState, useEffect, useMemo, useRef } from "react";
import { Info, Play, RefreshCw, Trophy, Tv } from "lucide-react";
import { Agent } from "../components/Agent";
import { PIECES, RANKS, FILES, piecesFromFen, squareToPoint } from "../utils/chess";

export function LiveGame() {
  const [boardState, setBoardState] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const eventSource = useRef<EventSource | null>(null);

  useEffect(() => {
    let reconnectTimeout: any;
    function connect() {
      if (eventSource.current) {
        eventSource.current.close();
      }
      const es = new EventSource("/api/events");
      eventSource.current = es;

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          setBoardState(data);
          setError(null);
        } catch (err) {
          console.error("Parse error", err);
        }
      };

      es.onerror = () => {
        setError("Connection lost. Reconnecting...");
        es.close();
        reconnectTimeout = setTimeout(connect, 2000);
      };
    }
    connect();
    return () => {
      if (eventSource.current) eventSource.current.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  const handleReset = async () => {
    await fetch("/api/reset", { method: "POST" });
  };

  const displayPieces = useMemo(() => {
    if (!boardState) return [];
    return piecesFromFen(boardState.fen);
  }, [boardState]);

  if (!boardState) return <div className="loading">Connecting to Arena...</div>;

  const wAgent = boardState.agents.white;
  const bAgent = boardState.agents.black;

  return (
    <main className="watch-page">
      <section className="stage">
        <div className="board-wrap">
          <div className="board-frame">
            <div className="rank-labels">
              {RANKS.map((rank) => <span key={rank}>{rank}</span>)}
            </div>
            <div className="board">
              {RANKS.map((rank, row) =>
                FILES.map((file, col) => {
                  const square = `${file}${rank}`;
                  const isLast = boardState.lastMove && (boardState.lastMove.from === square || boardState.lastMove.to === square);
                  return <div key={square} className={`tile ${(row + col) % 2 ? "dark" : "light"} ${isLast ? "last" : ""}`} />
                })
              )}
              {displayPieces.map((piece) => {
                const point = squareToPoint(piece.square);
                return (
                  <div key={piece.id} className={`piece ${piece.color}`} style={{ transform: `translate(${point.x}%, ${point.y}%)` }}>
                    {PIECES[piece.key]}
                  </div>
                );
              })}
            </div>
            <div className="file-labels">
              {FILES.map((file) => <span key={file}>{file}</span>)}
            </div>
          </div>
          {boardState.lastMove && boardState.lastMove.reason && (
             <div className="reasoning-popup">
                <strong>{boardState.lastMove.color === "white" ? "White" : "Black"} ({boardState.lastMove.san}):</strong> {boardState.lastMove.reason}
             </div>
          )}
        </div>
      </section>

      <aside className="side">
        <div className="agents-stack">
          <Agent side="white" agent={wAgent} active={!boardState.gameOver && boardState.turn === "white"} />
          <div className="vs">VS</div>
          <Agent side="black" agent={bAgent} active={!boardState.gameOver && boardState.turn === "black"} />
        </div>

        <div className="status-card">
          {boardState.gameOver ? <Trophy size={18} /> : <Info size={18} />}
          <div>
            <span>{boardState.gameOver ? "Game Over" : "Status"}</span>
            <strong>{boardState.status}</strong>
          </div>
        </div>

        <button className="restart-button" onClick={handleReset}>
          <RefreshCw size={18} /> Restart Arena
        </button>

        {error && <div className="error-badge">{error}</div>}
      </aside>
    </main>
  );
}
