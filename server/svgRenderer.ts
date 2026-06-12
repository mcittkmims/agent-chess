import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";

import type { MoveStatusLabel } from "./engineAnalysis.js";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];
const STARTING_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"];

type StatusKind = "playing" | "check" | "checkmate" | "draw";

const pieceAssetFiles: Record<string, string> = {
  K: "wk.svg",
  Q: "wq.svg",
  R: "wr.svg",
  B: "wb.svg",
  N: "wn.svg",
  P: "wp.svg",
  k: "bk.svg",
  q: "bq.svg",
  r: "br.svg",
  b: "bb.svg",
  n: "bn.svg",
  p: "bp.svg",
};

const agentAvatarFiles = [
  "bot-amber.svg",
  "bot-ember.svg",
  "bot-ocean.svg",
  "bot-plum.svg",
  "bot-sage.svg",
  "bot-slate.svg",
];

const pieceAssetCache = new Map<string, string>();
const agentAvatarCache = new Map<string, string>();

function wrapText(text: string, maxCharsPerLine: number) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";
  for (const word of words) {
    if ((currentLine + word).length > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = `${word} `;
    } else {
      currentLine += `${word} `;
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  return lines;
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getPieceAssetHref(key: string) {
  if (pieceAssetCache.has(key)) return pieceAssetCache.get(key)!;
  const filename = pieceAssetFiles[key];
  const svg = readFileSync(join(process.cwd(), "src", "assets", "pieces", filename), "utf8");
  const href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  pieceAssetCache.set(key, href);
  return href;
}

function hashName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getAgentAvatarHref(name: string) {
  if (agentAvatarCache.has(name)) return agentAvatarCache.get(name)!;
  const filename = agentAvatarFiles[hashName(name || "agent") % agentAvatarFiles.length];
  const svg = readFileSync(join(process.cwd(), "src", "assets", "agents", filename), "utf8");
  const href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  agentAvatarCache.set(name, href);
  return href;
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

function squareToCoords(square: string, boardX: number, boardY: number, squareSize: number) {
  const file = square.charCodeAt(0) - 97;
  const rank = 8 - parseInt(square[1], 10);
  return {
    x: boardX + file * squareSize,
    y: boardY + rank * squareSize,
  };
}

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function capturedFromBoard(board: ReturnType<Chess["board"]>) {
  const counts = {
    white: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    black: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };

  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      if (!(piece.type in STARTING_COUNTS)) continue;
      if (piece.color === "w") counts.white[piece.type as keyof typeof counts.white] += 1;
      else counts.black[piece.type as keyof typeof counts.black] += 1;
    }
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

function capturedEntries(captured: Record<string, number>, side: "white" | "black") {
  return CAPTURE_ORDER.flatMap((type) => {
    const count = captured[type] || 0;
    if (!count) return [];
    const key = side === "white" ? type.toUpperCase() : type;
    return [{ id: `${side}-${type}`, key, count }];
  });
}

function renderCapturedTray(
  side: "white" | "black",
  pieces: { id: string; key: string; count: number }[],
  x: number,
  boardY: number,
  boardSize: number,
) {
  if (!pieces.length) return "";

  const trayWidth = 96;
  const itemHeight = 62;
  const trayHeight = Math.max(164, pieces.length * itemHeight + 28);
  const trayY = boardY + (boardSize - trayHeight) / 2;
  const pieceSize = 42;
  const countX = x + 17;
  const pieceX = x + 44;
  const firstRowY = trayY + 44;
  const fill = side === "white" ? "rgba(250, 248, 243, 0.95)" : "rgba(243, 245, 239, 0.95)";
  const stroke = side === "white" ? "rgba(156, 146, 128, 0.34)" : "rgba(105, 123, 82, 0.3)";
  const shadow = side === "white" ? "rgba(66, 53, 38, 0.08)" : "rgba(42, 64, 27, 0.08)";

  let svg = `<g>\n`;
  svg += `<rect x="${x}" y="${trayY + 4}" width="${trayWidth}" height="${trayHeight}" rx="26" fill="${shadow}" />\n`;
  svg += `<rect x="${x}" y="${trayY}" width="${trayWidth}" height="${trayHeight}" rx="26" fill="${fill}" stroke="${stroke}" stroke-width="2" />\n`;

  pieces.forEach((piece, index) => {
    const rowY = firstRowY + index * itemHeight;
    const href = getPieceAssetHref(piece.key);
    svg += `<text x="${countX}" y="${rowY}" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#5f584d">${piece.count}x</text>\n`;
    svg += `<image href="${href}" x="${pieceX}" y="${rowY - 34}" width="${pieceSize}" height="${pieceSize}" preserveAspectRatio="xMidYMid meet" />\n`;
  });

  svg += `</g>\n`;
  return svg;
}

export interface ReplayCommentaryFrame {
  color: "white" | "black";
  san: string;
  speaker: string;
  text: string;
  revealedChars?: number;
  revealedWords?: number;
  popProgress?: number;
}

export interface ReplayStatusOverlayFrame {
  label: MoveStatusLabel | "unknown";
  text: string;
  popProgress?: number;
}

export interface ReplayExportFrame {
  fen: string;
  previousFen?: string | null;
  lastMove?: any | null;
  commentary?: ReplayCommentaryFrame | null;
  statusOverlay?: ReplayStatusOverlayFrame | null;
  moveProgress?: number;
  agents?: {
    white?: { name?: string | null } | null;
    black?: { name?: string | null } | null;
  } | null;
}

function renderMatchupHeader(
  agents: NonNullable<ReplayExportFrame["agents"]>,
) {
  const whiteName = agents.white?.name?.trim() || "White";
  const blackName = agents.black?.name?.trim() || "Black";
  const cardSize = 128;
  const cardY = 74;
  const whiteCardX = 186;
  const blackCardX = 1080 - 186 - cardSize;
  const nameY = cardY + cardSize + 46;
  const labelY = cardY + cardSize + 20;
  const vsCx = 540;
  const vsCy = cardY + 58;

  const renderCard = (
    name: string,
    side: "white" | "black",
    x: number,
  ) => {
    const accent = side === "white" ? "#f4f0dd" : "#dce8d1";
    const stroke = side === "white" ? "rgba(122, 115, 104, 0.28)" : "rgba(92, 119, 73, 0.3)";
    const shadow = side === "white" ? "rgba(70, 59, 46, 0.12)" : "rgba(59, 85, 44, 0.14)";
    const textFill = "#27251f";
    const avatarHref = getAgentAvatarHref(name);
    const sideLabel = side === "white" ? "White" : "Black";

    return [
      `<g>`,
      `<rect x="${x}" y="${cardY + 6}" width="${cardSize}" height="${cardSize}" rx="30" fill="${shadow}" />`,
      `<rect x="${x}" y="${cardY}" width="${cardSize}" height="${cardSize}" rx="30" fill="${accent}" stroke="${stroke}" stroke-width="2" />`,
      `<image href="${avatarHref}" x="${x + 18}" y="${cardY + 18}" width="${cardSize - 36}" height="${cardSize - 36}" preserveAspectRatio="xMidYMid meet" />`,
      `<text x="${x + cardSize / 2}" y="${labelY}" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#7a7368" letter-spacing="1.8">${sideLabel.toUpperCase()}</text>`,
      `<text x="${x + cardSize / 2}" y="${nameY}" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="${textFill}">${escapeXml(name)}</text>`,
      `</g>`,
    ].join("\n");
  };

  return [
    `<g>`,
    renderCard(whiteName, "white", whiteCardX),
    renderCard(blackName, "black", blackCardX),
    `<circle cx="${vsCx}" cy="${vsCy}" r="52" fill="#fbf8ef" stroke="rgba(122, 115, 104, 0.32)" stroke-width="2" />`,
    `<text x="${vsCx}" y="${vsCy + 12}" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" font-weight="800" fill="#3a352d" letter-spacing="2">VS</text>`,
    `</g>`,
  ].join("\n");
}

export function generateFrameSvg({
  fen,
  previousFen = null,
  lastMove = null,
  commentary = null,
  statusOverlay = null,
  moveProgress = 1,
  agents = null,
}: ReplayExportFrame) {
  const chess = new Chess(fen);
  const previousChess = previousFen ? new Chess(previousFen) : null;
  const board = chess.board();

  const squareSize = 105;
  const boardX = 120;
  const boardY = 300;
  const boardSize = squareSize * 8;
  const pieceInset = squareSize * 0.08;
  const pieceSize = squareSize - pieceInset * 2;
  const captured = capturedFromBoard(board);
  const blackLost = capturedEntries(captured.black, "black");
  const whiteLost = capturedEntries(captured.white, "white");

  const statusKind = getStatusKind(chess);
  const checkedKingSquare = findCheckedKingSquare(chess);
  const isAnimatingMove = Boolean(previousChess && lastMove && moveProgress < 0.999);

  let squaresSvg = "";
  let piecesSvg = "";

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const isLight = (row + col) % 2 === 0;
      const x = boardX + col * squareSize;
      const y = boardY + row * squareSize;
      const fill = isLight ? "#eeeed2" : "#769656";
      const squareName = `${FILES[col]}${RANKS[row]}`;
      const isLast = lastMove && (lastMove.from === squareName || lastMove.to === squareName);
      const isCheckedKing = checkedKingSquare === squareName;

      squaresSvg += `<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="${fill}" />\n`;
      if (isLast) {
        squaresSvg += `<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="rgba(255, 235, 59, 0.45)" />\n`;
      }
      if (isCheckedKing) {
        const overlayFill = statusKind === "checkmate" ? "rgba(166, 16, 16, 0.52)" : "rgba(196, 38, 38, 0.32)";
        const overlayStroke = statusKind === "checkmate" ? "rgba(134, 0, 0, 0.92)" : "rgba(196, 38, 38, 0.82)";
        squaresSvg += `<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="${overlayFill}" />\n`;
        squaresSvg += `<rect x="${x + 4}" y="${y + 4}" width="${squareSize - 8}" height="${squareSize - 8}" fill="none" stroke="${overlayStroke}" stroke-width="5" />\n`;
      }

      const piece = board[row][col];
      if (!piece) continue;
      if (isAnimatingMove && squareName === lastMove.to) continue;
      const key = piece.color === "w" ? piece.type.toUpperCase() : piece.type;
      const href = getPieceAssetHref(key);
      piecesSvg += `<image href="${href}" x="${x + pieceInset}" y="${y + pieceInset}" width="${pieceSize}" height="${pieceSize}" preserveAspectRatio="xMidYMid meet" />\n`;
    }
  }

  if (isAnimatingMove && previousChess && lastMove) {
    const movingPiece = previousChess.get(lastMove.from as any);
    if (movingPiece) {
      const start = squareToCoords(lastMove.from, boardX, boardY, squareSize);
      const end = squareToCoords(lastMove.to, boardX, boardY, squareSize);
      const key = movingPiece.color === "w" ? movingPiece.type.toUpperCase() : movingPiece.type;
      const href = getPieceAssetHref(key);
      const x = lerp(start.x, end.x, moveProgress) + pieceInset;
      const y = lerp(start.y, end.y, moveProgress) + pieceInset;
      piecesSvg += `<image href="${href}" x="${x}" y="${y}" width="${pieceSize}" height="${pieceSize}" preserveAspectRatio="xMidYMid meet" />\n`;
    }
  }

  const capturedSvg = [
    renderCapturedTray("black", blackLost, 12, boardY, boardSize),
    renderCapturedTray("white", whiteLost, 972, boardY, boardSize),
  ].join("");
  const matchupHeaderSvg = renderMatchupHeader(agents ?? {
    white: { name: "White" },
    black: { name: "Black" },
  });

  let commentarySvg = "";
  if (commentary) {
    const totalText = commentary.text || "";
    const visibleText = typeof commentary.revealedChars === "number"
      ? totalText.slice(0, commentary.revealedChars)
      : typeof commentary.revealedWords === "number"
        ? totalText.trim().split(/\s+/).filter(Boolean).slice(0, commentary.revealedWords).join(" ")
        : totalText;
    const lines = visibleText ? wrapText(visibleText, 42) : [];
    const hasCursor = visibleText.length < totalText.length;
    const textHeight = Math.max(lines.length, 1) * 38;
    const boxHeight = textHeight + 108;
    const boxY = boardY + 8 * squareSize + 50 + (1 - (commentary.popProgress ?? 1)) * 18;
    const bubbleWidth = 708;
    const avatarSize = 58;
    const avatarFrameX = commentary.color === "white" ? 90 : 1080 - 90 - avatarSize;
    const bubbleX = commentary.color === "white" ? 164 : 1080 - 164 - bubbleWidth;
    const bubbleFill = commentary.color === "white" ? "#eef4e4" : "#f0f2f6";
    const opacity = 0.45 + (commentary.popProgress ?? 1) * 0.55;
    const avatarHref = getAgentAvatarHref(commentary.speaker);
    const tailSvg = commentary.color === "white"
      ? `<path d="M ${bubbleX + 24} ${boxY + boxHeight - 8} C ${bubbleX + 8} ${boxY + boxHeight - 8}, ${bubbleX + 10} ${boxY + boxHeight + 18}, ${bubbleX + 28} ${boxY + boxHeight + 12}" fill="${bubbleFill}" />`
      : `<path d="M ${bubbleX + bubbleWidth - 24} ${boxY + boxHeight - 8} C ${bubbleX + bubbleWidth - 8} ${boxY + boxHeight - 8}, ${bubbleX + bubbleWidth - 10} ${boxY + boxHeight + 18}, ${bubbleX + bubbleWidth - 28} ${boxY + boxHeight + 12}" fill="${bubbleFill}" />`;

    commentarySvg += `<g opacity="${opacity}">\n`;
    commentarySvg += `<rect x="${avatarFrameX}" y="${boxY + 2}" width="${avatarSize}" height="${avatarSize}" rx="16" fill="#ffffff" stroke="rgba(38,36,33,0.08)" stroke-width="2" />\n`;
    commentarySvg += `<image href="${avatarHref}" x="${avatarFrameX}" y="${boxY + 2}" width="${avatarSize}" height="${avatarSize}" preserveAspectRatio="xMidYMid meet" />\n`;
    commentarySvg += `<rect x="${bubbleX}" y="${boxY}" width="${bubbleWidth}" height="${boxHeight}" fill="${bubbleFill}" rx="18" />\n`;
    commentarySvg += `${tailSvg}\n`;
    commentarySvg += `<text x="${bubbleX + 34}" y="${boxY + 42}" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#262421">${escapeXml(commentary.speaker)}</text>\n`;
    commentarySvg += `<text x="${bubbleX + 34}" y="${boxY + 68}" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#7a7368">Bot move ${escapeXml(commentary.san)}</text>\n`;

    let currentY = boxY + 100;
    if (lines.length === 0) {
      commentarySvg += `<rect x="${bubbleX + 34}" y="${currentY - 24}" width="10" height="26" rx="5" fill="rgba(95, 127, 57, 0.86)" />\n`;
    } else {
      let lastLineY = currentY;
      for (const line of lines) {
        lastLineY = currentY;
        commentarySvg += `<text x="${bubbleX + 34}" y="${currentY}" font-family="Arial, sans-serif" font-size="30" fill="#262421">${escapeXml(line)}</text>\n`;
        currentY += 38;
      }
      if (hasCursor) {
        commentarySvg += `<rect x="${bubbleX + 34 + Math.min((lines.at(-1)?.length || 0) * 15.5, bubbleWidth - 130)}" y="${lastLineY - 24}" width="10" height="26" rx="5" fill="rgba(95, 127, 57, 0.86)" />\n`;
      }
    }
    commentarySvg += `</g>\n`;
  }

  let statusOverlaySvg = "";
  if (statusOverlay?.text) {
    const pop = statusOverlay.popProgress ?? 1;
    const statusText = escapeXml(statusOverlay.text);
    const badgeWidth = Math.max(260, Math.min(560, 150 + statusOverlay.text.length * 22));
    const badgeHeight = 112;
    const badgeX = (1080 - badgeWidth) / 2;
    const badgeY = boardY + boardSize + 78 + (1 - pop) * 20;
    const tones: Record<string, { fill: string; stroke: string; text: string; glow: string }> = {
      brilliant: { fill: "#dff3ff", stroke: "#59aef3", text: "#0f5d90", glow: "rgba(89, 174, 243, 0.22)" },
      great: { fill: "#dff8f4", stroke: "#4bb7a6", text: "#136e64", glow: "rgba(75, 183, 166, 0.22)" },
      best: { fill: "#eaf5dc", stroke: "#83b54a", text: "#4f7421", glow: "rgba(131, 181, 74, 0.22)" },
      excellent: { fill: "#f2f8e9", stroke: "#a8bc74", text: "#63783a", glow: "rgba(168, 188, 116, 0.2)" },
      good: { fill: "#f5f4ef", stroke: "#b8b0a1", text: "#5e594f", glow: "rgba(94, 89, 79, 0.14)" },
      inaccuracy: { fill: "#fff6d8", stroke: "#e2bf4e", text: "#8c6a09", glow: "rgba(226, 191, 78, 0.22)" },
      mistake: { fill: "#ffe8d9", stroke: "#e39158", text: "#924d19", glow: "rgba(227, 145, 88, 0.22)" },
      blunder: { fill: "#ffe0dd", stroke: "#e06262", text: "#912f2f", glow: "rgba(224, 98, 98, 0.24)" },
      forced: { fill: "#ece9fb", stroke: "#8a7dd5", text: "#51449f", glow: "rgba(138, 125, 213, 0.2)" },
      unknown: { fill: "#f3f2ef", stroke: "#bbb4a9", text: "#635d55", glow: "rgba(99, 93, 85, 0.14)" },
    };
    const tone = tones[statusOverlay.label] || tones.unknown;

    statusOverlaySvg += `<g opacity="${0.48 + pop * 0.52}">\n`;
    statusOverlaySvg += `<rect x="${badgeX}" y="${badgeY + 10}" width="${badgeWidth}" height="${badgeHeight}" rx="34" fill="${tone.glow}" />\n`;
    statusOverlaySvg += `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="${badgeHeight}" rx="34" fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="4" />\n`;
    statusOverlaySvg += `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 70}" text-anchor="middle" font-family="Arial, sans-serif" font-size="46" font-weight="800" fill="${tone.text}" letter-spacing="1.2">${statusText}</text>\n`;
    statusOverlaySvg += `</g>\n`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <rect width="1080" height="1920" fill="#efefef" />
    ${matchupHeaderSvg}
    <rect x="${boardX - 10}" y="${boardY - 10}" width="${boardSize + 20}" height="${boardSize + 20}" fill="#769656" />
    ${capturedSvg}
    ${squaresSvg}
    ${piecesSvg}
    ${commentarySvg}
    ${statusOverlaySvg}
  </svg>`;
}
