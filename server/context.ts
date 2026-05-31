import { Chess } from "chess.js";

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAMES: Record<string, string>  = { K: "King", Q: "Queen", R: "Rooks", B: "Bishops", N: "Knights", P: "Pawns" };
export const PIECE_ORDER  = ["K", "Q", "R", "B", "N", "P"];
const STARTING_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const BOARD_FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function colorToTurn(color: string) {
  return color === "white" ? "w" : "b";
}

function buildBoardMap(chess: Chess) {
  const map: Record<string, Record<string, string[]>> = { white: {}, black: {} };
  chess.board().forEach((row, rankIdx) => {
    row.forEach((piece, fileIdx) => {
      if (!piece) return;
      const square = `${BOARD_FILES[fileIdx]}${8 - rankIdx}`;
      const side = piece.color === "w" ? "white" : "black";
      const key = piece.type.toUpperCase();
      if (!map[side][key]) map[side][key] = [];
      map[side][key].push(square);
    });
  });
  return map;
}

function buildNarrative(chess: Chess, ctx: any) {
  const lines = [];
  const turn = chess.turn() === "w" ? "White" : "Black";

  lines.push(`Move ${ctx.moveNumber}. ${turn} to move. Phase: ${ctx.phase}.`);

  const mat = ctx.material;
  const balStr = mat.balance > 0
    ? `White ahead by ${mat.balance}`
    : mat.balance < 0
      ? `Black ahead by ${Math.abs(mat.balance)}`
      : "even";
  
  const wCap = Object.entries(mat.captured.white).map(([t, n]) => `${n}×${t}`).join(", ") || "none";
  const bCap = Object.entries(mat.captured.black).map(([t, n]) => `${n}×${t}`).join(", ") || "none";
  lines.push(`Material: ${balStr} (white=${mat.white}pts, black=${mat.black}pts). Captured — white lost: ${wCap}; black lost: ${bCap}.`);

  if (chess.isCheckmate()) {
    lines.push(`${turn} is in checkmate — game over.`);
  } else if (ctx.inCheck) {
    lines.push(`${turn} is in check and must resolve it this turn. All listed legal moves are valid responses.`);
  }

  if (ctx.piecesUnderAttack.white.length > 0) {
    lines.push(`White pieces attacked by black: ${ctx.piecesUnderAttack.white.map((e: any) => `${e.piece} on ${e.square}`).join(", ")}.`);
  }
  if (ctx.piecesUnderAttack.black.length > 0) {
    lines.push(`Black pieces attacked by white: ${ctx.piecesUnderAttack.black.map((e: any) => `${e.piece} on ${e.square}`).join(", ")}.`);
  }

  const castleNotes = [];
  const w = ctx.castling.white, b = ctx.castling.black;
  if (!w.kingSide && !w.queenSide) castleNotes.push("white can no longer castle");
  else if (!w.kingSide)  castleNotes.push("white has lost kingside castling");
  else if (!w.queenSide) castleNotes.push("white has lost queenside castling");
  if (!b.kingSide && !b.queenSide) castleNotes.push("black can no longer castle");
  else if (!b.kingSide)  castleNotes.push("black has lost kingside castling");
  else if (!b.queenSide) castleNotes.push("black has lost queenside castling");
  if (castleNotes.length > 0) lines.push(`Castling: ${castleNotes.join("; ")}.`);

  if (ctx.enPassant) {
    lines.push(`En passant capture available on square ${ctx.enPassant} this turn only.`);
  }

  if (ctx.promotionsAvailable.length > 0) {
    const squares = [...new Set(ctx.promotionsAvailable.map((p: any) => p.uci.slice(0, 4)))];
    lines.push(`Pawn promotion available at ${squares.join(", ")} — pawn MUST become another piece. Piece codes: q=queen(9pts) r=rook(5pts) b=bishop(3pts) n=knight(3pts). All four variants are listed in legalMoves.`);
  }

  const items = [];
  if (ctx.capturesAvailable.length > 0) items.push(`${ctx.capturesAvailable.length} capture${ctx.capturesAvailable.length !== 1 ? "s" : ""} available`);
  if (ctx.checksAvailable.length > 0)   items.push(`${ctx.checksAvailable.length} check-giving move${ctx.checksAvailable.length !== 1 ? "s" : ""} available`);
  if (items.length > 0) lines.push(`This turn: ${items.join(", ")}.`);

  if (ctx.halfmoveClock >= 40) {
    const remaining = 50 - ctx.halfmoveClock;
    lines.push(`50-move rule: draw in ${remaining} half-move${remaining !== 1 ? "s" : ""} if no capture or pawn move occurs.`);
  }

  return lines.join(" ");
}

export function computeContext(chess: Chess, verboseMoves: any[]) {
  const fen = chess.fen();
  const fenParts = fen.split(" ");
  const boardMap = buildBoardMap(chess);

  const onBoard: Record<string, Record<string, number>> = { w: {}, b: {} };
  let whiteMat = 0, blackMat = 0, totalPieces = 0;

  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      totalPieces++;
      onBoard[piece.color][piece.type] = (onBoard[piece.color][piece.type] || 0) + 1;
      if (piece.color === "w") whiteMat += PIECE_VALUES[piece.type] || 0;
      else blackMat += PIECE_VALUES[piece.type] || 0;
    }
  }

  const captured: Record<string, Record<string, number>> = { white: {}, black: {} };
  for (const type of Object.keys(STARTING_COUNTS)) {
    const wLost = STARTING_COUNTS[type] - (onBoard.w[type] || 0);
    const bLost = STARTING_COUNTS[type] - (onBoard.b[type] || 0);
    if (wLost > 0) captured.white[type] = wLost;
    if (bLost > 0) captured.black[type] = bLost;
  }

  const material = {
    balance: whiteMat - blackMat,
    white: whiteMat,
    black: blackMat,
    captured,
  };

  let phase;
  if (totalPieces >= 26)      phase = "opening";
  else if (totalPieces >= 14) phase = "middlegame";
  else                        phase = "endgame";

  const castlingStr = fenParts[2];
  const castling = {
    white: { kingSide: castlingStr.includes("K"), queenSide: castlingStr.includes("Q") },
    black: { kingSide: castlingStr.includes("k"), queenSide: castlingStr.includes("q") },
  };
  const enPassant    = fenParts[3] === "-" ? null : fenParts[3];
  const halfmoveClock = parseInt(fenParts[4], 10);
  const moveNumber    = parseInt(fenParts[5], 10);

  const capturesAvailable = verboseMoves
    .filter((m) => m.captured)
    .map((m) => ({
      uci:      `${m.from}${m.to}${m.promotion || ""}`,
      captures: `${m.captured.toUpperCase()} on ${m.to}`,
    }));

  const checksAvailable = verboseMoves
    .filter((m) => m.san.includes("+") || m.san.includes("#"))
    .map((m) => `${m.from}${m.to}${m.promotion || ""}`);

  const promotionsAvailable = verboseMoves
    .filter((m) => m.promotion)
    .map((m) => ({ uci: `${m.from}${m.to}${m.promotion}`, piece: m.promotion }));

  const piecesUnderAttack: Record<string, {square: string, piece: string}[]> = { white: [], black: [] };
  try {
    const flipped = fenParts.slice();
    flipped[1] = flipped[1] === "w" ? "b" : "w";
    flipped[3] = "-";
    const temp = new Chess(flipped.join(" "));
    const seen = new Set();
    for (const m of temp.moves({ verbose: true })) {
      if (!m.captured || seen.has(m.to)) continue;
      seen.add(m.to);
      const piece = chess.get(m.to as any);
      if (!piece) continue;
      const entry = { square: m.to, piece: piece.type.toUpperCase() };
      if (piece.color === "w") piecesUnderAttack.white.push(entry);
      else                     piecesUnderAttack.black.push(entry);
    }
  } catch (_) {}

  const inCheck = chess.isCheck();

  const context: any = {
    phase, moveNumber, boardMap, castling, enPassant, halfmoveClock,
    material, inCheck, piecesUnderAttack, capturesAvailable, checksAvailable, promotionsAvailable,
  };

  context.boardNarrative = buildNarrative(chess, context);
  return context;
}
