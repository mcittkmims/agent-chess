import React, { useState, useEffect, useMemo, useRef } from "react";
import { ChevronRight, Info, List, PanelRightClose, PanelRightOpen, RefreshCw, Trophy } from "lucide-react";
import { RANKS, FILES, capturedEntries, pieceImageForKey, piecesFromFen, squareToPoint } from "../utils/chess";
import { SOUND_DURATIONS_MS, moveSoundKey, moveSoundUrl } from "../utils/moveSound";

export function LiveGame({ onShowReplays }: { onShowReplays: () => void }) {
  const [boardState, setBoardState] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);
  const eventSource = useRef<EventSource | null>(null);
  const soundPlayersRef = useRef<Partial<Record<keyof typeof SOUND_DURATIONS_MS, HTMLAudioElement>>>({});
  const lastPlayedMoveRef = useRef<string | null>(null);

  useEffect(() => {
    const players = soundPlayersRef.current;
    (Object.keys(SOUND_DURATIONS_MS) as Array<keyof typeof SOUND_DURATIONS_MS>).forEach((key) => {
      const audio = new Audio(moveSoundUrl(key));
      audio.preload = "auto";
      players[key] = audio;
    });
  }, []);

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

  useEffect(() => {
    const move = boardState?.lastMove;
    if (!move?.at) return;
    const moveId = `${move.at}-${move.uci}`;
    if (lastPlayedMoveRef.current === moveId) return;
    lastPlayedMoveRef.current = moveId;

    const key = moveSoundKey(move);
    const base = soundPlayersRef.current[key];
    if (!base) return;
    const audio = base.cloneNode() as HTMLAudioElement;
    audio.volume = 0.9;
    void audio.play().catch(() => {});
  }, [boardState?.lastMove]);

  const handleReset = async () => {
    await fetch("/api/reset", { method: "POST" });
  };

  const displayPieces = useMemo(() => {
    if (!boardState) return [];
    return piecesFromFen(boardState.fen);
  }, [boardState]);

  const statusKind = useMemo(() => {
    if (!boardState?.status) return "playing";
    if (boardState.status.startsWith("Checkmate")) return "checkmate";
    if (boardState.status.startsWith("Check.")) return "check";
    if (boardState.status.startsWith("Draw")) return "draw";
    return "playing";
  }, [boardState]);

  const checkedKingSquare = useMemo(() => {
    if (!boardState?.context?.inCheck || !boardState?.context?.boardMap) return null;
    const sideToMove = boardState.turn === "black" ? "black" : "white";
    const kingSquares = boardState.context.boardMap[sideToMove]?.K;
    return Array.isArray(kingSquares) && kingSquares.length > 0 ? kingSquares[0] : null;
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
  const captured = boardState.context?.material?.captured || { white: {}, black: {} };
  const whiteLost = capturedEntries(captured.white, "white");
  const blackLost = capturedEntries(captured.black, "black");
  const renderPlayerCard = (side: "white" | "black", agent: { name: string; connectedAt: string } | null, active: boolean) => (
    <div className={`live-player-card ${active ? "active" : ""}`}>
      <strong>{agent ? agent.name : "Waiting..."}</strong>
      <span>{side} {active ? "• to move" : boardState.gameOver ? "• finished" : ""}</span>
    </div>
  );

  const renderCaptured = (side: "white" | "black", pieces: { id: string; key: string }[]) => (
    <div className={`captured-tray captured-${side}`}>
      <div className="captured-pieces">
        {pieces.length > 0 ? pieces.map((piece: any) => (
          <span key={piece.id} className="captured-item">
            <span className="captured-count">{piece.count}x</span>
            <img className={`captured-piece ${side}`} src={pieceImageForKey(piece.key)} alt="" draggable={false} />
          </span>
        )) : null}
      </div>
    </div>
  );

  return (
    <main className="watch-page live-layout">
      <div className="live-hud">
        <div className="live-match-strip" aria-label="Current matchup">
          {renderPlayerCard("white", wAgent, !boardState.gameOver && boardState.turn === "white")}
          <div className="live-match-vs">VS</div>
          {renderPlayerCard("black", bAgent, !boardState.gameOver && boardState.turn === "black")}
        </div>
        <button className="hud-toggle" onClick={() => setShowControls((open) => !open)} aria-expanded={showControls} aria-controls="live-controls">
          {showControls ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          Controls
        </button>
      </div>

      {showControls && <button className="live-backdrop" onClick={() => setShowControls(false)} aria-label="Close controls" />}

      <section className="stage">
        <div className="board-wrap">
          <div className="board-shell">
            {renderCaptured("black", blackLost)}
            <div className="board-frame">
              <div className="rank-labels">
                {RANKS.map((rank) => <span key={rank}>{rank}</span>)}
              </div>
              <div className="board">
                {RANKS.map((rank, row) =>
                  FILES.map((file, col) => {
                    const square = `${file}${rank}`;
                    const isLast = boardState.lastMove && (boardState.lastMove.from === square || boardState.lastMove.to === square);
                    const isCheckSquare = checkedKingSquare === square;
                    return <div key={square} className={`tile ${(row + col) % 2 ? "dark" : "light"} ${isLast ? "last" : ""} ${isCheckSquare ? (statusKind === "checkmate" ? "checkmate" : "check") : ""}`} />
                  })
                )}
                {displayPieces.map((piece) => {
                  const point = squareToPoint(piece.square);
                  return (
                    <div key={piece.id} className={`piece ${piece.color}`} style={{ transform: `translate(${point.x}%, ${point.y}%)` }}>
                      <img className="piece-art" src={pieceImageForKey(piece.key)} alt="" draggable={false} />
                    </div>
                  );
                })}
              </div>
              <div className="file-labels">
                {FILES.map((file) => <span key={file}>{file}</span>)}
              </div>
            </div>
            {renderCaptured("white", whiteLost)}
          </div>
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
