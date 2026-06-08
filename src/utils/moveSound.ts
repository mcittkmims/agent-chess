export const SOUND_DURATIONS_MS = {
  moveSelf: 154,
  moveOpponent: 153,
  capture: 371,
  moveCheck: 332,
  castle: 267,
  gameEnd: 285,
  promote: 262,
} as const;

export type MoveSoundKey = keyof typeof SOUND_DURATIONS_MS;

export function isCaptureMove(move: any) {
  return typeof move?.san === "string" && move.san.includes("x");
}

export function isCastleMove(move: any) {
  return typeof move?.san === "string" && (move.san.includes("O-O") || move.san.includes("0-0"));
}

export function isPromotionMove(move: any) {
  return typeof move?.uci === "string" ? move.uci.length === 5 : typeof move?.san === "string" && move.san.includes("=");
}

export function isCheckmateMove(move: any) {
  return typeof move?.san === "string" && move.san.includes("#");
}

export function isCheckMove(move: any) {
  return typeof move?.san === "string" && move.san.includes("+");
}

export function moveSoundKey(move: any): MoveSoundKey {
  if (isCheckmateMove(move)) return "gameEnd";
  if (isPromotionMove(move)) return "promote";
  if (isCastleMove(move)) return "castle";
  if (isCheckMove(move)) return "moveCheck";
  if (isCaptureMove(move)) return "capture";
  return move?.color === "black" ? "moveOpponent" : "moveSelf";
}

export function moveSoundDurationMs(move: any) {
  return SOUND_DURATIONS_MS[moveSoundKey(move)];
}

export function moveSoundUrl(key: MoveSoundKey) {
  const filename: Record<MoveSoundKey, string> = {
    moveSelf: "move-self.mp3",
    moveOpponent: "move-opponent.mp3",
    capture: "capture.mp3",
    moveCheck: "move-check.mp3",
    castle: "castle.mp3",
    gameEnd: "game-end.mp3",
    promote: "promote.mp3",
  };
  return `/api/audio/${filename[key]}`;
}

