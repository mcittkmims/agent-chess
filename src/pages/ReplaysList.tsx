import React, { useState, useEffect } from "react";

export function ReplaysList({ onSelect }: { onSelect: (id: string) => void }) {
  const [games, setGames] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/games")
      .then(r => r.json())
      .then(d => { if (d.ok) setGames(d.games); });
  }, []);

  return (
    <main className="watch-page">
      <div style={{ maxWidth: 800, margin: "0 auto", width: "100%", padding: 20 }}>
        <h2 style={{ marginBottom: 20 }}>Replays</h2>
        {games.length === 0 ? <p>No finished games recorded yet.</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
            {games.map(g => (
              <div 
                key={g.gameId} 
                onClick={() => onSelect(g.gameId)}
                style={{
                  background: "#fff", border: "1px solid #e1e1e1",
                  borderRadius: 12, padding: 20, cursor: "pointer",
                  display: "flex", justifyContent: "space-between", alignItems: "center"
                }}
              >
                <div>
                  <h3 style={{ fontSize: 18, marginBottom: 5 }}>
                    {g.agents?.white?.name || "White"} vs {g.agents?.black?.name || "Black"}
                  </h3>
                  <div style={{ color: "#666", fontSize: 14 }}>
                    {new Date(g.updatedAt).toLocaleString()} • ID: {g.gameId.split("-")[0]}...
                  </div>
                </div>
                <div style={{ fontWeight: 600, color: "var(--brand)" }}>View Replay →</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
