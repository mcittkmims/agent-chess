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

  return (
    <div className="app-container">
      <nav className="top-nav">
        <button className={view === "live" ? "active" : ""} onClick={() => { setView("live"); window.history.pushState({}, "", "?view=live"); }}>
          <Sparkles size={18} /> Live Game
        </button>
        <button className={view === "replays" ? "active" : ""} onClick={() => { setView("replays"); window.history.pushState({}, "", "?view=replays"); }}>
          <List size={18} /> Replays
        </button>
      </nav>
      {view === "live" && <LiveGame />}
      {view === "replays" && <ReplaysList onSelect={(id) => { setGameId(id); setView("replay"); window.history.pushState({}, "", `?view=replay&gameId=${id}`); }} />}
      {view === "replay" && gameId && <ReplayViewer gameId={gameId} />}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
