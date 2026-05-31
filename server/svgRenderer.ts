import { Chess } from "chess.js";

function wrapText(text: string, maxCharsPerLine: number) {
  const words = text.split(" ");
  let lines = [];
  let currentLine = "";
  for (const word of words) {
    if ((currentLine + word).length > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word + " ";
    } else {
      currentLine += word + " ";
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  return lines;
}

export function generateFrameSvg(fen: string, lastMove: any, reasoning: string | null) {
  const chess = new Chess(fen);
  const board = chess.board();
  
  const squareSize = 112.5;
  const boardX = 90;
  const boardY = 300;
  
  let squaresSvg = "";
  let piecesSvg = "";
  
  const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

  const UNICODE_PIECES: Record<string, Record<string, string>> = {
    w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
    b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" }
  };

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const isLight = (row + col) % 2 === 0;
      const x = boardX + col * squareSize;
      const y = boardY + row * squareSize;
      
      let fill = isLight ? "#eeeed2" : "#769656";
      
      const squareName = `${FILES[col]}${RANKS[row]}`;
      const isLast = lastMove && (lastMove.from === squareName || lastMove.to === squareName);
      
      squaresSvg += `<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="${fill}" />\n`;
      if (isLast) {
        squaresSvg += `<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="rgba(255, 235, 59, 0.45)" />\n`;
      }
      
      const piece = board[row][col];
      if (piece) {
        const char = UNICODE_PIECES[piece.color][piece.type];
        piecesSvg += `<text x="${x + squareSize/2}" y="${y + squareSize/2 + 35}" font-family="Times New Roman, Georgia, serif" font-size="80" text-anchor="middle" fill="${piece.color === 'w' ? '#ffffff' : '#222222'}">${char}</text>\n`;
      }
    }
  }

  let reasoningSvg = "";
  if (reasoning) {
    const lines = wrapText(reasoning, 50);
    const textHeight = lines.length * 40;
    const boxHeight = textHeight + 60;
    const boxY = boardY + 8 * squareSize + 50;
    
    reasoningSvg += `<rect x="90" y="${boxY}" width="900" height="${boxHeight}" fill="#ffffff" rx="10" stroke="#d8d8d8" stroke-width="2" />\n`;
    
    let currentY = boxY + 50;
    for (const line of lines) {
      reasoningSvg += `<text x="130" y="${currentY}" font-family="Arial, sans-serif" font-size="30" fill="#262421">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>\n`;
      currentY += 40;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <rect width="1080" height="1920" fill="#efefef" />
    <rect x="${boardX - 10}" y="${boardY - 10}" width="920" height="920" fill="#769656" />
    ${squaresSvg}
    ${piecesSvg}
    ${reasoningSvg}
  </svg>`;
}
