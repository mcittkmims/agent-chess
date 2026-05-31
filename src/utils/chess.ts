export const PIECES: Record<string, string> = {
  p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔",
  P: "♟", N: "♞", B: "♝", R: "♜", Q: "♛", K: "♚"
};

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
export const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

export interface Piece {
  id: string;
  square: string;
  key: string;
  color: string;
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
  const file = square.charCodeAt(0) - 97; // a=0, b=1...
  const rank = 8 - parseInt(square[1], 10);
  return { x: file * 100, y: rank * 100 };
}
