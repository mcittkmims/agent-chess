import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ManifestMove = {
  move: {
    san: string;
    reason: string;
  };
};

type ReplayManifest = {
  moves: ManifestMove[];
};

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function trimSentence(value: string, maxLength = 78) {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  const cut = compact.slice(0, maxLength);
  const lastBreak = Math.max(cut.lastIndexOf(","), cut.lastIndexOf(" "), cut.lastIndexOf("."));
  return `${cut.slice(0, lastBreak > 24 ? lastBreak : maxLength).trim()}.`;
}

function has(text: string, pattern: RegExp) {
  return pattern.test(text);
}

function shortenReason(san: string, originalReason: string) {
  const reason = compactWhitespace(originalReason);
  const lower = reason.toLowerCase();

  if (san.includes("#")) return "I finish the attack with mate.";
  if (lower.includes("only one legal move") || lower.includes("only pawn interpositions remain")) {
    return "I only have one move, so I keep resisting.";
  }
  if (lower.includes("forced line") || lower.includes("forced sequence")) {
    return "I follow the forced line and keep resisting.";
  }
  if (san === "O-O") return "I castle to keep my king safe and bring my rook in.";
  if (san === "O-O-O") return "I castle long to activate my rook and stay active.";
  if (/^K/.test(san) && has(lower, /\bb-file\b/)) return "I step away from the b-file pressure and keep my edge.";
  if (/^K/.test(san) && has(lower, /\bking safety\b|\bsidesteps\b/)) return "I step out of danger and keep my position together.";
  if (san.includes("x") && san.includes("+")) {
    if (has(lower, /\bpawn\b/)) return "I grab the pawn with check and keep pressing.";
    if (has(lower, /\bpiece\b|\bdefensive piece\b/)) return "I take a key defender with check and keep the attack going.";
    if (has(lower, /\bking\b.*\bopen\b|\bmating net\b/)) return "I give a forcing check and drive the king into the open.";
    return "I capture with check and keep the initiative.";
  }
  if (san.includes("+")) {
    if (has(lower, /\bking hunt\b|\bmating net\b|\brun out into the center\b|\binto the open\b/)) {
      return "I give check and drag the king farther into the open.";
    }
    if (has(lower, /\bdevelop/)) return "I develop with check and keep the initiative.";
    if (has(lower, /\bcounterplay\b|\bperpetual\b/)) return "I give check and look for counterplay.";
    return "I give check and keep the initiative.";
  }

  if (san.includes("x")) {
    if (has(lower, /\bqueenside structure\b/)) return "I damage the queenside structure and create targets.";
    if (has(lower, /\brook\b/)) return "I win the rook and keep the pressure on.";
    if (has(lower, /\bqueen\b/)) return "I take the queen and simplify.";
    if (has(lower, /\bfree pawn\b/)) return "I grab the pawn and hit the queen.";
    if (has(lower, /\bwins? a pawn\b/)) return "I grab the pawn and stay active.";
    if (has(lower, /\bpawn\b/)) {
      if (has(lower, /\bopen lines\b/)) return "I take the pawn and open lines.";
      if (has(lower, /\bcenter\b/)) return "I recapture toward the center and keep space.";
      return "I take the pawn and improve my position.";
    }
    if (has(lower, /\bdefender\b|\battacker\b/)) return "I remove a key piece and simplify.";
    if (has(lower, /\bknight\b/)) return "I remove the knight and steady my position.";
    if (has(lower, /\bpiece\b/)) return "I win a piece and keep the initiative.";
    return "I capture and improve my position.";
  }

  if (has(lower, /\bb-file\b/)) return "I line up pressure on the b-file.";
  if (has(lower, /\bking safety\b|\bking safe\b/)) return "I improve my king safety and activate my pieces.";
  if (has(lower, /\bcounterplay\b/)) return "I stay active and keep counterplay.";
  if (has(lower, /\battack\b.*\bking\b/)) return "I build pressure on the king.";
  if (has(lower, /\binitiative\b/) && has(lower, /\bcenter\b/)) return "I take space in the center and keep the initiative.";
  if (has(lower, /\binitiative\b/)) return "I keep the initiative and stay active.";
  if (has(lower, /\bdevelops with tempo\b/) && has(lower, /\bknight\b/)) return "I develop with tempo and hit the knight.";
  if (has(lower, /\bpressure\b/) && has(lower, /\bking\b/)) return "I add pressure on the king.";
  if (has(lower, /\bpressure\b/)) return "I add pressure and stay active.";
  if (has(lower, /\bdevelop\b|\bdevelopment\b/)) {
    if (has(lower, /\bbishop\b/)) return "I develop my bishop and stay active.";
    if (has(lower, /\bknight\b/)) return "I develop my knight and challenge the center.";
    return "I develop and improve my position.";
  }
  if (has(lower, /\bopen lines\b/) && has(lower, /\bcenter\b/)) return "I open the center and free my pieces.";
  if (has(lower, /\bcenter\b/)) return "I fight for the center.";
  if (has(lower, /\bresistance\b/)) return "I keep resisting and look for practical chances.";

  const trimmed = trimSentence(reason);
  if (/^[A-Z][a-z]+ing\b/.test(trimmed)) {
    return trimSentence(trimmed.replace(/^([A-Z][a-z]+)ing\b/, (_m, stem) => `I ${stem.toLowerCase()}`));
  }
  if (/^(With|After|Instead of)\b/.test(trimmed)) {
    const clause = trimmed.split(/,\s+/).pop() || trimmed;
    const normalized = clause.replace(/\bBlacks\b/g, "Black's").replace(/\bWhites\b/g, "White's");
    return trimSentence(normalized.startsWith("I ") ? normalized : `I ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`);
  }

  return "I improve my position and stay active.";
}

async function main() {
  const manifestArg = process.argv[2];
  if (!manifestArg) {
    console.log("Usage: node --import tsx scripts/rewrite-manifest-reasons.ts <manifest.json>");
    process.exitCode = 1;
    return;
  }

  const manifestPath = resolve(manifestArg);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReplayManifest;
  manifest.moves = manifest.moves.map((entry) => ({
    ...entry,
    move: {
      ...entry.move,
      reason: shortenReason(entry.move.san, entry.move.reason),
    },
  }));

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated reasons in ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
