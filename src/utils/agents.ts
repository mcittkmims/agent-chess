import amber from "../assets/agents/bot-amber.svg";
import ember from "../assets/agents/bot-ember.svg";
import ocean from "../assets/agents/bot-ocean.svg";
import plum from "../assets/agents/bot-plum.svg";
import sage from "../assets/agents/bot-sage.svg";
import slate from "../assets/agents/bot-slate.svg";

const AGENT_AVATARS = [amber, ember, ocean, plum, sage, slate];

function hashName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function agentAvatarForName(name: string) {
  return AGENT_AVATARS[hashName(name || "agent") % AGENT_AVATARS.length];
}
