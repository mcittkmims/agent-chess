import wk from "../assets/pieces/wk.svg";
import wq from "../assets/pieces/wq.svg";
import wr from "../assets/pieces/wr.svg";
import wb from "../assets/pieces/wb.svg";
import wn from "../assets/pieces/wn.svg";
import wp from "../assets/pieces/wp.svg";
import bk from "../assets/pieces/bk.svg";
import bq from "../assets/pieces/bq.svg";
import br from "../assets/pieces/br.svg";
import bb from "../assets/pieces/bb.svg";
import bn from "../assets/pieces/bn.svg";
import bp from "../assets/pieces/bp.svg";

export const PIECE_IMAGES: Record<string, string> = {
  K: wk,
  Q: wq,
  R: wr,
  B: wb,
  N: wn,
  P: wp,
  k: bk,
  q: bq,
  r: br,
  b: bb,
  n: bn,
  p: bp,
};

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
export const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];
const STARTING_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"];

export interface Piece {
  id: string;
  square: string;
  key: string;
  color: string;
}

export function pieceImageForKey(key: string) {
  return PIECE_IMAGES[key];
}

export function piecesFromFen(fen: string): Piece[] {
  if (!fen) return [];
  const parts = fen.split(" ");
  if (parts.length === 0) return [];
  const board = parts[0];
  const rows = board.split("/");
  const pieces: Piece[] = [];
  rows.forEach((row, rankIdx) => {
    let fileIdx = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        fileIdx += parseInt(char, 10);
      } else {
        const file = FILES[fileIdx];
        const rank = RANKS[rankIdx];
        const color = char === char.toUpperCase() ? "white" : "black";
        pieces.push({
          id: `${char}-${file}${rank}`,
          square: `${file}${rank}`,
          key: char,
          color,
        });
        fileIdx++;
      }
    }
  });
  return pieces;
}

export function squareToPoint(square: string) {
  const file = square.charCodeAt(0) - 97;
  const rank = 8 - parseInt(square[1], 10);
  return { x: file * 100, y: rank * 100 };
}

export function capturedFromFen(fen: string) {
  const counts = {
    white: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    black: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };

  for (const piece of piecesFromFen(fen)) {
    const type = piece.key.toLowerCase();
    if (!(type in STARTING_COUNTS)) continue;
    if (piece.color === "white") counts.white[type as keyof typeof counts.white] += 1;
    else counts.black[type as keyof typeof counts.black] += 1;
  }

  const captured = {
    white: {} as Record<string, number>,
    black: {} as Record<string, number>,
  };

  for (const type of CAPTURE_ORDER) {
    const whiteLost = STARTING_COUNTS[type] - counts.white[type as keyof typeof counts.white];
    const blackLost = STARTING_COUNTS[type] - counts.black[type as keyof typeof counts.black];
    if (whiteLost > 0) captured.white[type] = whiteLost;
    if (blackLost > 0) captured.black[type] = blackLost;
  }

  return captured;
}

export function capturedEntries(captured: Record<string, number>, side: "white" | "black") {
  return CAPTURE_ORDER.flatMap((type) => {
    const count = captured[type] || 0;
    if (!count) return [];
    const key = side === "white" ? type.toUpperCase() : type;
    return [{ id: `${side}-${type}`, key, count }];
  });
}
