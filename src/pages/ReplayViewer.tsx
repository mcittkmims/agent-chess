import React, { useState, useEffect, useMemo, useRef } from "react";
import { Chess } from "chess.js";
import { Download, Gauge, Pause, Play, SkipBack, SkipForward, Swords, Tv } from "lucide-react";
import {
  RANKS,
  FILES,
  capturedEntries,
  capturedFromFen,
  pieceImageForKey,
  piecesFromFen,
  squareToPoint,
  type Piece,
} from "../utils/chess";
import { agentAvatarForName } from "../utils/agents";
import { SOUND_DURATIONS_MS, moveSoundDurationMs, moveSoundKey, moveSoundUrl } from "../utils/moveSound";
const CHAR_REVEAL_MS = 42;
const COMMENTARY_MIN_TAIL_MS = 220;
const COMMENTARY_SETTLE_MS = 260;

type StatusKind = "playing" | "check" | "checkmate" | "draw";
type MoveStatusLabel =
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "unknown";

interface TimelineStep {
  fen: string;
  lastMove: any;
  pieces: Piece[];
  pieceMap: Record<string, Piece>;
  status: string;
  statusKind: StatusKind;
  checkedKingSquare: string | null;
}

interface AnimatedMove {
  id: string;
  key: string;
  color: string;
  startSquare: string;
  endSquare: string;
  hideSquare: string;
  durationMs: number;
}

interface ReplayEngineAnalysis {
  engine: {
    name: string;
    depth: number;
    multiPv: number;
  };
  positions: Array<{
    score: {
      whiteAdvantage: number;
      display: string;
    } | null;
  }>;
  moves: Array<{
    label: MoveStatusLabel;
    display: string;
    bestMove: string | null;
    centipawnLoss: number | null;
  }>;
}

interface MoveGradeAnnouncement {
  key: string;
  visible: boolean;
}

function getStatusText(chess: Chess) {
  if (chess.isCheckmate()) return `Checkmate. ${chess.turn() === "w" ? "Black" : "White"} wins.`;
  if (chess.isStalemate()) return "Draw by stalemate.";
  if (chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (chess.isInsufficientMaterial()) return "Draw by insufficient material.";
  if (chess.isDraw()) return "Draw.";
  return chess.isCheck() ? "Check." : "Playing.";
}

function getStatusKind(chess: Chess): StatusKind {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isDraw()) return "draw";
  if (chess.isCheck()) return "check";
  return "playing";
}

function findCheckedKingSquare(chess: Chess) {
  if (!chess.isCheck()) return null;
  const kingColor = chess.turn();
  const board = chess.board();
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row].length; col++) {
      const piece = board[row][col];
      if (!piece || piece.type !== "k" || piece.color !== kingColor) continue;
      return `${FILES[col]}${8 - row}`;
    }
  }
  return null;
}

function moveAnimationMs(move: any) {
  return moveSoundDurationMs(move);
}

function commentaryCharCount(reason: string) {
  return Math.max(1, reason.trim().length);
}

function commentaryTypingDurationMs(move: any) {
  return Math.max(
    moveAnimationMs(move) + COMMENTARY_MIN_TAIL_MS,
    commentaryCharCount(move.reason || "") * CHAR_REVEAL_MS,
  );
}

function playbackDelayForMove(move: any) {
  return Math.max(1400, commentaryTypingDurationMs(move) + COMMENTARY_SETTLE_MS);
}

function evalBarWhitePercent(whiteAdvantage: number | null | undefined) {
  if (!Number.isFinite(whiteAdvantage)) return 50;
  const logistic = 100 / (1 + Math.exp(-(whiteAdvantage as number) / 160));
  return Math.min(96, Math.max(4, logistic));
}

function reviewPathSquares(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return new Set<string>();

  const fromFile = from.charCodeAt(0) - 97;
  const toFile = to.charCodeAt(0) - 97;
  const fromRank = Number.parseInt(from[1], 10);
  const toRank = Number.parseInt(to[1], 10);
  const fileDiff = toFile - fromFile;
  const rankDiff = toRank - fromRank;
  const fileStep = Math.sign(fileDiff);
  const rankStep = Math.sign(rankDiff);
  const isStraight = fromFile === toFile || fromRank === toRank;
  const isDiagonal = Math.abs(fileDiff) === Math.abs(rankDiff);
  const squares = new Set<string>([from, to]);

  if (!isStraight && !isDiagonal) return squares;

  const distance = Math.max(Math.abs(fileDiff), Math.abs(rankDiff));
  for (let step = 1; step < distance; step++) {
    const file = String.fromCharCode(97 + fromFile + fileStep * step);
    const rank = String(fromRank + rankStep * step);
    squares.add(`${file}${rank}`);
  }

  return squares;
}

function moveGradeSymbol(label: MoveStatusLabel) {
  switch (label) {
    case "best":
      return "★";
    case "excellent":
      return "✓";
    case "good":
      return ".";
    case "inaccuracy":
      return "?!";
    case "mistake":
      return "?";
    case "blunder":
      return "??";
    default:
      return ".";
  }
}

export function ReplayViewer({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<any>(null);
  const [analysis, setAnalysis] = useState<ReplayEngineAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [moveIndex, setMoveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [animatedMove, setAnimatedMove] = useState<AnimatedMove | null>(null);
  const [moveGradeAnnouncement, setMoveGradeAnnouncement] = useState<MoveGradeAnnouncement | null>(null);
  const [animationProgress, setAnimationProgress] = useState(1);
  const [revealedCharCount, setRevealedCharCount] = useState(0);
  const [animateLatestMessage, setAnimateLatestMessage] = useState(false);
  const commentaryRef = useRef<HTMLDivElement | null>(null);
  const previousMoveIndexRef = useRef(0);
  const soundPlayersRef = useRef<Partial<Record<keyof typeof SOUND_DURATIONS_MS, HTMLAudioElement>>>({});

  useEffect(() => {
    const players = soundPlayersRef.current;
    (Object.keys(SOUND_DURATIONS_MS) as Array<keyof typeof SOUND_DURATIONS_MS>).forEach((key) => {
      const audio = new Audio(moveSoundUrl(key));
      audio.preload = "auto";
      players[key] = audio;
    });
  }, []);

  useEffect(() => {
    fetch(`/api/games/${gameId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setGame(d.game);
          setMoveIndex(0);
          previousMoveIndexRef.current = 0;
        }
      });
  }, [gameId]);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setAnalysisError(null);
    setIsAnalyzing(true);

    fetch(`/api/analysis/${gameId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.ok) {
          setAnalysis(d.analysis);
          setAnalysisError(null);
          return;
        }
        setAnalysisError(d.error || "Analysis unavailable");
      })
      .catch(() => {
        if (!cancelled) setAnalysisError("Analysis unavailable");
      })
      .finally(() => {
        if (!cancelled) setIsAnalyzing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [gameId]);

  useEffect(() => {
    let timer: any;
    if (isPlaying && game && moveIndex < game.history.length) {
      timer = setTimeout(() => setMoveIndex((i) => i + 1), playbackDelayForMove(game.history[moveIndex]));
    } else if (isPlaying && game && moveIndex >= game.history.length) {
      setIsPlaying(false);
    }
    return () => clearTimeout(timer);
  }, [isPlaying, moveIndex, game]);

  const timeline = useMemo<TimelineStep[]>(() => {
    if (!game) return [];
    const chess = new Chess();
    const steps: TimelineStep[] = [];

    const pushStep = (lastMove: any) => {
      const fen = chess.fen();
      const pieces = piecesFromFen(fen);
      const pieceMap = Object.fromEntries(pieces.map((piece) => [piece.square, piece]));
      steps.push({
        fen,
        lastMove,
        pieces,
        pieceMap,
        status: getStatusText(chess),
        statusKind: getStatusKind(chess),
        checkedKingSquare: findCheckedKingSquare(chess),
      });
    };

    pushStep(null);
    for (const move of game.history) {
      chess.move(move.uci);
      pushStep(move);
    }

    return steps;
  }, [game]);

  const boardState = timeline[moveIndex] || null;
  const currentMove = game?.history[moveIndex - 1] || null;
  const currentMoveAnalysis = moveIndex > 0 ? analysis?.moves[moveIndex - 1] || null : null;
  const currentPositionAnalysis = analysis?.positions[moveIndex] || null;
  const evalPercent = evalBarWhitePercent(currentPositionAnalysis?.score?.whiteAdvantage);
  const evalDisplay = currentPositionAnalysis?.score?.display || "0.0";
  const moveGradeText = moveIndex === 0
    ? "Start position"
    : currentMoveAnalysis?.display || (isAnalyzing ? "Analyzing..." : "Unknown");
  const moveGradeFromSquare = moveIndex > 0 ? currentMove?.from || boardState?.lastMove?.from || null : null;
  const moveGradeSquare = moveIndex > 0 ? currentMove?.to || boardState?.lastMove?.to || null : null;
  const persistentReviewPathSquares = useMemo(
    () => reviewPathSquares(currentMoveAnalysis ? moveGradeFromSquare : null, currentMoveAnalysis ? moveGradeSquare : null),
    [currentMoveAnalysis, moveGradeFromSquare, moveGradeSquare],
  );
  const showMoveGradeTiles = Boolean(currentMoveAnalysis && persistentReviewPathSquares.size > 0);
  const showMoveGradeColor = Boolean(moveGradeAnnouncement?.visible && showMoveGradeTiles);
  const showMoveGradeBadge = showMoveGradeColor;

  const commentaryMoves = useMemo(() => {
    if (!game) return [];
    return game.history
      .slice(0, moveIndex)
      .filter((move: any) => move.reason)
      .map((move: any, index: number) => {
        const side = move.color === "black" ? "black" : "white";
        return {
          ...move,
          id: `${move.at}-${index}`,
          side,
          speaker: game.agents?.[side]?.name || (side === "white" ? "White" : "Black"),
        };
      });
  }, [game, moveIndex]);

  useEffect(() => {
    if (!game || timeline.length === 0) return;

    const previousMoveIndex = previousMoveIndexRef.current;
    const delta = moveIndex - previousMoveIndex;
    if (delta === 0) return;
    setAnimateLatestMessage(delta > 0);

    const isSingleStep = Math.abs(delta) === 1;
    if (!isSingleStep) {
      setAnimatedMove(null);
      setAnimationProgress(1);
      previousMoveIndexRef.current = moveIndex;
      return;
    }

    const movingForward = delta > 0;
    const move = movingForward ? game.history[moveIndex - 1] : game.history[previousMoveIndex - 1];
    const startStep = timeline[movingForward ? previousMoveIndex : moveIndex];
    const endStep = timeline[movingForward ? moveIndex : previousMoveIndex];
    if (!move || !startStep || !endStep) {
      previousMoveIndexRef.current = moveIndex;
      return;
    }

    const startSquare = movingForward ? move.from : move.to;
    const endSquare = movingForward ? move.to : move.from;
    const movingPiece = startStep.pieceMap[startSquare] || endStep.pieceMap[endSquare];
    if (!movingPiece) {
      setAnimatedMove(null);
      previousMoveIndexRef.current = moveIndex;
      return;
    }

    const animationId = `${previousMoveIndex}-${moveIndex}-${move.at}`;
    const durationMs = moveAnimationMs(move);
    if (movingForward) {
      const key = moveSoundKey(move);
      const base = soundPlayersRef.current[key];
      if (base) {
        const audio = base.cloneNode() as HTMLAudioElement;
        audio.volume = 0.9;
        void audio.play().catch(() => {});
      }
    }
    setAnimatedMove({
      id: animationId,
      key: movingPiece.key,
      color: movingPiece.color,
      startSquare,
      endSquare,
      hideSquare: endSquare,
      durationMs,
    });
    setAnimationProgress(0);

    const raf = requestAnimationFrame(() => setAnimationProgress(1));
    const timer = setTimeout(() => {
      setAnimatedMove((current) => (current?.id === animationId ? null : current));
    }, durationMs + 60);

    previousMoveIndexRef.current = moveIndex;
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [moveIndex, game, timeline]);

  useEffect(() => {
    const latestMove = commentaryMoves[commentaryMoves.length - 1];
    if (!latestMove) {
      setRevealedCharCount(0);
      return;
    }
    const totalChars = latestMove.reason.length;

    if (!animateLatestMessage) {
      setRevealedCharCount(totalChars);
      return;
    }

    if (totalChars === 0) {
      setRevealedCharCount(0);
      return;
    }

    const typingDurationMs = commentaryTypingDurationMs(latestMove);
    let frameId = 0;
    let startTime = 0;

    const step = (now: number) => {
      if (!startTime) startTime = now;
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / typingDurationMs);
      const nextChars = Math.min(totalChars, Math.max(1, Math.ceil(progress * totalChars)));
      setRevealedCharCount(nextChars);
      if (progress < 1) frameId = requestAnimationFrame(step);
    };

    setRevealedCharCount(1);
    frameId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frameId);
  }, [animateLatestMessage, commentaryMoves]);

  useEffect(() => {
    if (!commentaryRef.current) return;
    commentaryRef.current.scrollTop = commentaryRef.current.scrollHeight;
  }, [commentaryMoves, revealedCharCount]);

  useEffect(() => {
    if (moveIndex <= 0 || !currentMoveAnalysis) {
      setMoveGradeAnnouncement(null);
      return;
    }

    const announcement = {
      key: `${moveIndex}-${currentMoveAnalysis.label}-${currentMoveAnalysis.display}`,
      visible: true,
    };
    setMoveGradeAnnouncement(announcement);

    const timer = setTimeout(() => {
      setMoveGradeAnnouncement((current) => (current?.key === announcement.key ? null : current));
    }, 1600);

    return () => clearTimeout(timer);
  }, [moveIndex, currentMoveAnalysis]);

  const displayPieces = useMemo(() => {
    if (!boardState) return [];
    return boardState.pieces.filter((piece) => !animatedMove || piece.square !== animatedMove.hideSquare);
  }, [boardState, animatedMove]);

  const captured = useMemo(
    () => (boardState ? capturedFromFen(boardState.fen) : { white: {}, black: {} }),
    [boardState],
  );
  const whiteLost = useMemo(() => capturedEntries(captured.white, "white"), [captured]);
  const blackLost = useMemo(() => capturedEntries(captured.black, "black"), [captured]);

  const renderCaptured = (side: "white" | "black", pieces: { id: string; key: string }[]) => (
    <div className={`captured-tray captured-${side}`}>
      <div className="captured-pieces">
        {pieces.length > 0
          ? pieces.map((piece: any) => (
              <span key={piece.id} className="captured-item">
                <span className="captured-count">{piece.count}x</span>
                <img className={`captured-piece ${side}`} src={pieceImageForKey(piece.key)} alt="" draggable={false} />
              </span>
            ))
          : null}
      </div>
    </div>
  );

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

  if (!game || !boardState) {
    return (
      <div className="live-loading" aria-live="polite" aria-busy="true">
        <div className="live-loading-spinner" />
      </div>
    );
  }

  const movingPiecePosition = animatedMove
    ? (() => {
        const start = squareToPoint(animatedMove.startSquare);
        const end = squareToPoint(animatedMove.endSquare);
        return {
          x: start.x + (end.x - start.x) * animationProgress,
          y: start.y + (end.y - start.y) * animationProgress,
        };
      })()
    : null;
  const moveGradeBadgePosition = moveGradeSquare ? squareToPoint(moveGradeSquare) : null;
  const moveGradeBadgeFlip = moveGradeSquare
    ? moveGradeSquare.charCodeAt(0) - 97 >= 6
    : false;

  return (
    <main className="watch-page replay-layout">
      <section className="stage">
        <div className="board-wrap">
          <div className="board-shell replay-board-shell">
            {renderCaptured("black", blackLost)}
            <div className="replay-board-cluster">
              <div className="eval-bar-card" aria-label="Engine evaluation bar">
                <span className="eval-bar-side top">Black</span>
                <div className="eval-bar-track">
                  <div className="eval-bar-segment black" style={{ height: `${100 - evalPercent}%` }} />
                  <div className="eval-bar-segment white" style={{ height: `${evalPercent}%` }} />
                  <div className="eval-bar-marker" style={{ bottom: `calc(${evalPercent}% - 18px)` }}>
                    {evalDisplay}
                  </div>
                </div>
                <span className="eval-bar-side bottom">White</span>
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
                      const isCheckSquare = boardState.checkedKingSquare === square;
                      const isPersistentReviewSquare = showMoveGradeTiles && persistentReviewPathSquares.has(square);
                      return (
                        <div
                          key={square}
                          className={`tile ${(row + col) % 2 ? "dark" : "light"} ${isLast ? "last" : ""} ${isPersistentReviewSquare ? "trail" : ""} ${isPersistentReviewSquare ? `review ${(showMoveGradeColor ? "review-active" : "review-fade")} ${currentMoveAnalysis?.label || "unknown"}` : ""} ${isCheckSquare ? (boardState.statusKind === "checkmate" ? "checkmate" : "check") : ""}`}
                        />
                      );
                    }),
                  )}
                  {showMoveGradeBadge ? (
                    <div
                      key={moveGradeAnnouncement?.key}
                      className={`move-grade-corner-anchor ${moveGradeBadgeFlip ? "flip" : ""}`}
                      style={{ transform: `translate(${moveGradeBadgePosition?.x || 0}%, ${moveGradeBadgePosition?.y || 0}%)` }}
                    >
                      <div className={`move-grade-corner ${currentMoveAnalysis?.label || "unknown"}`}>
                        <span className="move-grade-corner-symbol">{moveGradeSymbol(currentMoveAnalysis?.label || "unknown")}</span>
                      </div>
                    </div>
                  ) : null}
                  {displayPieces.map((piece) => {
                    const point = squareToPoint(piece.square);
                    return (
                      <div
                        key={`${piece.key}-${piece.square}`}
                        className={`piece ${piece.color}`}
                        style={{ transform: `translate(${point.x}%, ${point.y}%)` }}
                      >
                        <img className="piece-art" src={pieceImageForKey(piece.key)} alt="" draggable={false} />
                      </div>
                    );
                  })}
                  {animatedMove && movingPiecePosition ? (
                    <div
                      className={`piece moving-piece ${animatedMove.color}`}
                      style={{
                        transform: `translate(${movingPiecePosition.x}%, ${movingPiecePosition.y}%)`,
                        transitionDuration: `${animatedMove.durationMs}ms`,
                      }}
                    >
                      <img className="piece-art" src={pieceImageForKey(animatedMove.key)} alt="" draggable={false} />
                    </div>
                  ) : null}
                </div>
                <div className="file-labels">
                  {FILES.map((file) => <span key={file}>{file}</span>)}
                </div>
              </div>
              <div className="eval-bar-spacer" aria-hidden="true" />
            </div>
            {renderCaptured("white", whiteLost)}
          </div>
        </div>
      </section>

      <aside className="side replay-side">
        <div className="status-card">
          <Tv size={18} />
          <div>
            <span>Replay</span>
            <strong>{game.agents?.white?.name || "White"} vs {game.agents?.black?.name || "Black"}</strong>
          </div>
        </div>

        <div className="replay-meta">
          <span>Move {moveIndex} of {game.history.length}</span>
          <strong>
            {currentMove
              ? `${currentMove.san} played by ${currentMove.color === "white" ? game.agents?.white?.name || "White" : game.agents?.black?.name || "Black"}`
              : "Start position"}
          </strong>
          <div className={`replay-state-inline ${boardState.statusKind}`}>{boardState.status}</div>
          <div className="engine-summary">
            <div className={`move-grade-pill ${currentMoveAnalysis?.label || (moveIndex === 0 ? "good" : "unknown")}`}>
              <Gauge size={15} />
              <span>{moveGradeText}</span>
            </div>
            {moveIndex > 0 && currentMoveAnalysis ? (
              <div className="engine-summary-detail">
                {currentMoveAnalysis.bestMove ? `Best: ${currentMoveAnalysis.bestMove}` : "Best line unavailable"}
                {typeof currentMoveAnalysis.centipawnLoss === "number" ? ` • CPL ${currentMoveAnalysis.centipawnLoss}` : ""}
              </div>
            ) : analysisError ? (
              <div className="engine-summary-detail muted">{analysisError}</div>
            ) : isAnalyzing ? (
              <div className="engine-summary-detail muted">Stockfish is reviewing the replay…</div>
            ) : null}
          </div>
        </div>

        <div className="playback-controls">
          <button onClick={() => setMoveIndex(0)} disabled={moveIndex === 0}><SkipBack size={18} /></button>
          <button onClick={() => setMoveIndex((i) => Math.max(0, i - 1))} disabled={moveIndex === 0}>Prev</button>
          <button onClick={() => setIsPlaying(!isPlaying)}>
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button onClick={() => setMoveIndex((i) => Math.min(game.history.length, i + 1))} disabled={moveIndex === game.history.length}>Next</button>
          <button onClick={() => setMoveIndex(game.history.length)} disabled={moveIndex === game.history.length}><SkipForward size={18} /></button>
        </div>

        <button className="restart-button replay-export-button" onClick={handleExport} disabled={isExporting}>
          <Download size={18} />
          {isExporting ? "Exporting..." : "Export to MP4"}
        </button>

        <section className="commentary-panel" aria-label="Replay commentary">
          <div className="commentary-panel-header">
            <span>Conversation</span>
            <strong>Move notes</strong>
          </div>
          <div className="commentary-thread" ref={commentaryRef}>
            {commentaryMoves.length === 0 ? (
              <div className="commentary-empty">
                Step through the replay to watch the players&apos; move notes appear like a live conversation.
              </div>
            ) : (
              commentaryMoves.map((move: any, index: number) => {
                const isLatest = index === commentaryMoves.length - 1;
                const visibleText = isLatest ? move.reason.slice(0, revealedCharCount) : move.reason;
                const isTyping = isLatest && visibleText.length < move.reason.length;
                return (
                  <article
                    key={move.id}
                    className={`commentary-message ${move.side} ${isLatest ? "latest" : ""}`}
                  >
                    <img className="commentary-avatar" src={agentAvatarForName(move.speaker)} alt="" draggable={false} />
                    <div className="commentary-content">
                      <div className="commentary-header">
                        <strong>{move.speaker}</strong>
                        <span>{move.san}</span>
                      </div>
                      <div className={`commentary-bubble ${isTyping ? "typing" : ""}`}>
                        {visibleText}
                        {isTyping ? <span className="commentary-cursor" /> : null}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <div className="replay-tip">
          <Swords size={16} />
          <span>Autoplay waits for each comment to finish typing before advancing.</span>
        </div>
      </aside>
    </main>
  );
}
