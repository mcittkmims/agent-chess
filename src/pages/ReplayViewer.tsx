import React, { useState, useEffect, useMemo } from "react";
import { Chess } from "chess.js";
import { Download, Pause, Play, SkipBack, SkipForward, Tv } from "lucide-react";
import { PIECES, RANKS, FILES, piecesFromFen, squareToPoint } from "../utils/chess";

export function ReplayViewer({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<any>(null);
  const [moveIndex, setMoveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    fetch(`/api/games/${gameId}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setGame(d.game);
          setMoveIndex(0);
        }
      });
  }, [gameId]);

  useEffect(() => {
    let timer: any;
    if (isPlaying && game && moveIndex < game.history.length) {
      timer = setTimeout(() => setMoveIndex(i => i + 1), 500);
    } else if (isPlaying && game && moveIndex >= game.history.length) {
      setIsPlaying(false);
    }
    return () => clearTimeout(timer);
  }, [isPlaying, moveIndex, game]);

  const currentMove = game?.history[moveIndex - 1];
  
  const boardState = useMemo(() => {
    if (!game) return null;
    const c = new Chess();
    for (let i = 0; i < moveIndex; i++) {
      c.move(game.history[i].uci);
    }
    return {
      fen: c.fen(),
      lastMove: currentMove
    };
  }, [game, moveIndex, currentMove]);

  const displayPieces = useMemo(() => {
    if (!boardState) return [];
    return piecesFromFen(boardState.fen);
  }, [boardState]);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const res = await fetch(`/api/export/${gameId}`, { method: "POST" });
      const data = await res.json();
      if (data.ok && data.url) {
        window.location.href = data.url;
      }
    } catch (e) {
      console.error(e);
      alert("Export failed");
    } finally {
      setIsExporting(false);
    }
  };

  if (!game) return <div style={{padding: 20}}>Loading game...</div>;

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
                  const isLast = boardState?.lastMove && (boardState.lastMove.from === square || boardState.lastMove.to === square);
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
          {currentMove && currentMove.reason && (
             <div className="reasoning-popup">
                <strong>{currentMove.color === "white" ? "White" : "Black"} ({currentMove.san}):</strong> {currentMove.reason}
             </div>
          )}
        </div>
      </section>

      <aside className="side">
        <div className="status-card">
          <Tv size={18} />
          <div>
            <span>Replay</span>
            <strong>{game.agents?.white?.name || "White"} vs {game.agents?.black?.name || "Black"}</strong>
          </div>
        </div>
        <div className="playback-controls">
          <button onClick={() => setMoveIndex(0)} disabled={moveIndex === 0}><SkipBack size={18} /></button>
          <button onClick={() => setMoveIndex(i => Math.max(0, i - 1))} disabled={moveIndex === 0}>Prev</button>
          <button onClick={() => setIsPlaying(!isPlaying)}>
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button onClick={() => setMoveIndex(i => Math.min(game.history.length, i + 1))} disabled={moveIndex === game.history.length}>Next</button>
          <button onClick={() => setMoveIndex(game.history.length)} disabled={moveIndex === game.history.length}><SkipForward size={18} /></button>
        </div>
        
        <button className="restart-button" onClick={handleExport} disabled={isExporting}>
          <Download size={18} />
          {isExporting ? "Exporting..." : "Export to MP4"}
        </button>
      </aside>
    </main>
  );
}
