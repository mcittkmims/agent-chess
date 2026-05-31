import React from "react";
import { Bot, Cpu } from "lucide-react";

interface AgentProps {
  side: string;
  agent: { name: string; connectedAt: string } | null;
  active: boolean;
}

export function Agent({ side, agent, active }: AgentProps) {
  const color = side === "white" ? "var(--agent-white)" : "var(--agent-black)";
  return (
    <div className={`agent-profile ${active ? "active" : ""} ${side}`} style={{ "--theme": color } as React.CSSProperties}>
      <div className="agent-avatar">
        {agent ? <Bot size={24} /> : <Cpu size={24} />}
      </div>
      <div className="agent-info">
        <h3>{side}</h3>
        <p>{agent ? agent.name : "Waiting for agent..."}</p>
      </div>
    </div>
  );
}
