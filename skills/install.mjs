#!/usr/bin/env node
// Install the `create-slack-dev` skill so your coding agent can stand up a Slack Dev agent for you.
//
//   npx slack-dev-skill              # install (or update) it
//   npx slack-dev-skill --where      # just print where things would go
//   npx slack-dev-skill --uninstall
//
// Why a script rather than "copy this folder": there is no shared skill format. Claude Code reads
// ~/.claude/skills/<name>/SKILL.md; Codex and several others read an AGENTS.md in the working directory.
// So one command writes the right thing for each, and tells you plainly what it did.
//
// Zero dependencies, and it only ever writes inside the two paths it prints.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "create-slack-dev";
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, NAME);

const claudeSkill = join(homedir(), ".claude", "skills", NAME);
// The skill was called this before the project was renamed to Slack Dev. Left behind it's a SECOND,
// stale copy of the same skill competing for the same triggers — the "half-updated skill" problem this
// installer otherwise avoids by replacing rather than merging.
const legacySkill = join(homedir(), ".claude", "skills", "create-slack-agent");
const agentsFile = resolve(process.cwd(), "AGENTS.md");

const MARKER_START = "<!-- slack-dev:start -->";
const MARKER_END = "<!-- slack-dev:end -->";

/** What a non-Claude agent needs: where the skill is, and that it should read it. */
function agentsBlock() {
  return `${MARKER_START}
## Slack Dev

To stand up a Slack agent for a repository or an AWS account, follow the instructions in
\`${claudeSkill}/SKILL.md\` — read that file first and do what it says. It covers gathering the inputs you
must not guess, registering the GitHub App, deploying, and connecting Slack.
${MARKER_END}`;
}

function install() {
  if (!existsSync(SOURCE)) {
    console.error(`✗ Can't find the skill at ${SOURCE} — is this package intact?`);
    process.exit(1);
  }

  mkdirSync(dirname(claudeSkill), { recursive: true });
  const updating = existsSync(claudeSkill);
  // Replace rather than merge: a half-updated skill (new SKILL.md, stale references/) is worse than
  // either version alone, and everything here is regenerable from the package.
  if (updating) rmSync(claudeSkill, { recursive: true, force: true });
  cpSync(SOURCE, claudeSkill, { recursive: true });
  console.log(`${updating ? "↻ updated" : "✓ installed"}  ${claudeSkill}`);
  if (existsSync(legacySkill)) {
    rmSync(legacySkill, { recursive: true, force: true });
    console.log(`✓ removed   ${legacySkill}  (renamed; it would have competed with the above)`);
  }
  console.log(`             Claude Code — ask it to "create a slack agent for this repo"`);

  // AGENTS.md is the convention for Codex and friends. Only touch it if one already exists in this
  // directory: creating one in a random cwd would be litter, and in someone's repo it's a file they own.
  if (existsSync(agentsFile)) {
    const current = readFileSync(agentsFile, "utf8");
    const block = agentsBlock();
    if (current.includes(MARKER_START)) {
      const next = current.replace(
        new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`),
        block,
      );
      if (next !== current) writeFileSync(agentsFile, next);
      console.log(`↻ updated  ${agentsFile}  (the Slack Dev section)`);
    } else {
      writeFileSync(agentsFile, `${current.trimEnd()}\n\n${block}\n`);
      console.log(`✓ appended ${agentsFile}  (a pointer for Codex and other AGENTS.md agents)`);
    }
  } else {
    console.log(`\n  No AGENTS.md here, so nothing was added for Codex-style agents.`);
    console.log(`  Run this from a project that has one, or point your agent at:`);
    console.log(`    ${claudeSkill}/SKILL.md`);
  }

  console.log(`\nThen just ask: "create a slack agent for this repo".`);
}

function uninstall() {
  if (existsSync(legacySkill)) {
    rmSync(legacySkill, { recursive: true, force: true });
    console.log(`✓ removed  ${legacySkill}`);
  }
  if (existsSync(claudeSkill)) {
    rmSync(claudeSkill, { recursive: true, force: true });
    console.log(`✓ removed  ${claudeSkill}`);
  } else {
    console.log(`—  nothing at ${claudeSkill}`);
  }
  if (existsSync(agentsFile)) {
    const current = readFileSync(agentsFile, "utf8");
    if (current.includes(MARKER_START)) {
      // Only ever remove OUR block — the rest of the file belongs to whoever wrote it.
      writeFileSync(
        agentsFile,
        current
          .replace(new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n*`), "\n")
          .trimEnd() + "\n",
      );
      console.log(`✓ removed the Slack Dev section from ${agentsFile}`);
    }
  }
}

const arg = process.argv[2];
if (arg === "--uninstall") uninstall();
else if (arg === "--where") {
  console.log(`skill      → ${claudeSkill}`);
  console.log(`AGENTS.md  → ${agentsFile}${existsSync(agentsFile) ? "" : "  (absent; would be skipped)"}`);
} else if (arg && arg !== "install") {
  console.error(`Usage: npx slack-dev-skill [install|--where|--uninstall]`);
  process.exit(1);
} else install();
