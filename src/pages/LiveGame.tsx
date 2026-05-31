import React, { useState, useEffect, useMemo, useRef } from "react";
import { ChevronRight, Info, List, PanelRightClose, PanelRightOpen, RefreshCw, Trophy } from "lucide-react";
import { Agent } from "../components/Agent";
import { PIECES, RANKS, FILES, piecesFromFen, squareToPoint } from "../utils/chess";

export function LiveGame({ onShowReplays }: { onShowReplays: () => void }) {
  const [boardState, setBoardState] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);
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

  if (!boardState) {
    return (
      <div className="live-loading" aria-live="polite" aria-busy="true">
        <div className="live-loading-spinner" />
      </div>
    );
  }

  const wAgent = boardState.agents.white;
  const bAgent = boardState.agents.black;
  const statusLabel = boardState.gameOver ? "Final" : `${boardState.turn} to move`;
  const renderPlayerBanner = (side: "white" | "black", agent: { name: string; connectedAt: string } | null, active: boolean) => (
    <div className={`live-player live-player-${side} ${active ? "active" : ""}`}>
      <span className="live-player-side">{side}</span>
      <strong>{agent ? agent.name : `Waiting for ${side} agent`}</strong>
      <span className="live-player-state">{active ? "To move" : boardState.gameOver ? "Finished" : "Waiting"}</span>
    </div>
  );

  return (
    <main className="watch-page live-layout">
      <div className="live-hud">
        <div className="live-status">
          {boardState.gameOver ? <Trophy size={16} /> : <Info size={16} />}
          <div>
            <strong>{statusLabel}</strong>
            <span>{boardState.status}</span>
          </div>
        </div>
        <button className="hud-toggle" onClick={() => setShowControls((open) => !open)} aria-expanded={showControls} aria-controls="live-controls">
          {showControls ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          Controls
        </button>
      </div>

      {showControls && <button className="live-backdrop" onClick={() => setShowControls(false)} aria-label="Close controls" />}

      <section className="stage">
        <div className="board-wrap">
          <div className="live-matchup">
            {renderPlayerBanner("black", bAgent, !boardState.gameOver && boardState.turn === "black")}
          </div>
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
          <div className="live-matchup">
            {renderPlayerBanner("white", wAgent, !boardState.gameOver && boardState.turn === "white")}
          </div>
          {boardState.lastMove && boardState.lastMove.reason && (
             <div className="reasoning-popup">
                <strong>{boardState.lastMove.color === "white" ? "White" : "Black"} ({boardState.lastMove.san}):</strong> {boardState.lastMove.reason}
             </div>
          )}
        </div>
      </section>

      <aside id="live-controls" className={`live-drawer ${showControls ? "open" : ""}`}>
        <div className="drawer-header">
          <h2>Game Controls</h2>
          <button className="drawer-close" onClick={() => setShowControls(false)} aria-label="Close controls">
            <ChevronRight size={18} />
          </button>
        </div>

        <div className="status-card drawer-card">
          {boardState.gameOver ? <Trophy size={18} /> : <Info size={18} />}
          <div>
            <span>{boardState.gameOver ? "Game Over" : "Status"}</span>
            <strong>{boardState.status}</strong>
          </div>
        </div>

        <div className="agents-stack drawer-card">
          <Agent side="white" agent={wAgent} active={!boardState.gameOver && boardState.turn === "white"} />
          <div className="vs">VS</div>
          <Agent side="black" agent={bAgent} active={!boardState.gameOver && boardState.turn === "black"} />
        </div>

        <div className="drawer-actions">
          <button className="utility-button" onClick={onShowReplays}>
            <List size={18} /> Browse Replays
          </button>
          <button className="restart-button" onClick={handleReset}>
            <RefreshCw size={18} /> Restart Arena
          </button>
        </div>

        {error && <div className="error-badge">{error}</div>}
      </aside>
    </main>
  );
}
