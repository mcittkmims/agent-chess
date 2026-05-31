import { Chess } from "chess.js";
import http from "node:http";

export interface AgentInfo {
  token: string;
  name: string;
  connectedAt: string;
}

export interface GameHistoryEntry {
  color: string;
  san: string;
  uci: string;
  from: string;
  to: string;
  reason: string;
  at: string;
}

export interface GameState {
  id: string;
  stateVersion: number;
  chess: Chess;
  agents: { white: AgentInfo | null; black: AgentInfo | null };
  history: GameHistoryEntry[];
  updatedAt: string;
}

export interface ClientConnection {
  color: "white" | "black" | null;
  res: http.ServerResponse;
  token: string | null;
  view: "compact" | "full";
}
