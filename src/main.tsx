import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { List, Sparkles } from "lucide-react";

import { LiveGame } from "./pages/LiveGame";
import { ReplaysList } from "./pages/ReplaysList";
import { ReplayViewer } from "./pages/ReplayViewer";
import "./styles.css";

function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const initialView = urlParams.get("view") || "live";
  const [view, setView] = useState(initialView);
  const [gameId, setGameId] = useState(urlParams.get("gameId"));

  const navigate = (nextView: string, nextGameId?: string | null) => {
    setView(nextView);
    if (typeof nextGameId !== "undefined") setGameId(nextGameId);
    const params = new URLSearchParams();
    params.set("view", nextView);
    if (nextView === "replay" && nextGameId) params.set("gameId", nextGameId);
    window.history.pushState({}, "", `?${params.toString()}`);
  };

  return (
    <div className="app-container">
      {view !== "live" && (
        <nav className="top-nav">
          <button className={view === "live" ? "active" : ""} onClick={() => navigate("live", null)}>
            <Sparkles size={18} /> Live Game
          </button>
          <button className={view === "replays" ? "active" : ""} onClick={() => navigate("replays", null)}>
            <List size={18} /> Replays
          </button>
        </nav>
      )}
      {view === "live" && <LiveGame onShowReplays={() => navigate("replays", null)} />}
      {view === "replays" && <ReplaysList onSelect={(id) => navigate("replay", id)} />}
      {view === "replay" && gameId && <ReplayViewer gameId={gameId} />}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
