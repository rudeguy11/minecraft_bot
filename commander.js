"use strict";

// ============================================================
// COMMANDER MODULE
// Lets one trusted "owner" player control the bot in chat.
//
// If a Gemini API key is configured (settings.json "ai" block +
// a GEMINI_API_KEY environment variable), every owner message is
// sent to Gemini, which picks one action (mine/goto/come/follow/
// stop/build/just-reply) and can design freeform structures on
// the fly using /fill and /setblock.
//
// If AI isn't configured (or a call fails), it automatically
// falls back to the older, free, offline keyword parser so the
// bot still responds to basic commands.
// ============================================================

const { Movements, goals } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalBlock } = goals;

// ---------- SAFETY CAPS FOR AI-DESIGNED BUILDS ----------
// These apply no matter what the AI proposes, to stop a bad or
// over-ambitious plan from lagging/griefing the world.
const MAX_BUILD_STEPS = 80;          // max fill/setblock instructions per build
const MAX_FILL_VOLUME = 20000;       // max blocks in any single /fill
const MAX_TOTAL_BLOCKS = 60000;      // max blocks across the whole build
const MAX_OFFSET = 80;               // max distance (blocks) from the bot any part of a build can be

// ---------- TOOLS THE AI CAN CALL ----------
const TOOLS = [
  {
    type: "function",
    name: "mine_block",
    description:
      "Mine (dig) a type of block. Use block_name 'LOOKING_AT' if the owner means whatever block they are currently looking at (e.g. 'mine this').",
    parameters: {
      type: "object",
      properties: {
        block_name: { type: "string", description: "Minecraft 1.20 block id, e.g. 'stone', 'oak_log', or 'LOOKING_AT'." },
        count: { type: "integer", description: "How many to mine. Default 1." },
      },
      required: ["block_name"],
    },
  },
  {
    type: "function",
    name: "go_to",
    description: "Walk to specific world coordinates.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        z: { type: "integer" },
      },
      required: ["x", "y", "z"],
    },
  },
  {
    type: "function",
    name: "come_to_owner",
    description: "Walk to the owner's current location.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "follow_owner",
    description: "Continuously follow the owner around until told to stop.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "stop",
    description: "Cancel whatever the bot is currently doing (mining, building, walking, following) and go back to idle wandering.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "build_structure",
    description:
      "Design and build any structure (house, tower, wall, statue, village, etc.) yourself using rectangular regions (fill) and single blocks (setblock), positioned as offsets from the bot's current standing position: dx=0,dy=0,dz=0 is the block the bot is standing on, +dy is up. Be creative, but keep the whole thing under about 20000 blocks and 60 steps.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "One short sentence describing what's being built, said in chat before it starts." },
        steps: {
          type: "array",
          description: "Ordered list of fill/setblock operations that make up the structure.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["fill", "setblock"] },
              block: { type: "string", description: "Minecraft 1.20 block id, e.g. 'bricks', 'oak_planks', 'glass_pane', 'air' (air clears space)." },
              dx1: { type: "integer" },
              dy1: { type: "integer" },
              dz1: { type: "integer" },
              dx2: { type: "integer" },
              dy2: { type: "integer" },
              dz2: { type: "integer" },
              dx: { type: "integer" },
              dy: { type: "integer" },
              dz: { type: "integer" },
            },
            required: ["type", "block"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    type: "function",
    name: "chat_reply",
    description: "Just say something back in chat with no other action - use this for greetings, small talk, questions, or anything that isn't one of the other actions.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

// ---------- FALLBACK (NO-AI) NATURAL-LANGUAGE PARSER ----------
// Used automatically if AI isn't configured, or if a Gemini call fails.
const FILLERS = new Set([
  "a", "an", "the", "please", "pls", "plz", "to", "for", "me", "now",
  "kindly", "my", "some", "just", "can", "you", "could", "would", "also",
  "then", "and", "with", "of", "up", "one", "out", "little", "small",
]);
const ACTION_SYNONYMS = {
  help: ["help", "commands", "command"],
  stop: ["stop", "cancel", "halt", "quit", "wait"],
  come: ["come"],
  follow: ["follow"],
  goto: ["goto", "go", "walk", "move", "head"],
  mine: ["mine", "dig", "break", "harvest", "chop", "get", "collect"],
};
function classifyAction(firstWord) {
  for (const [canonical, words] of Object.entries(ACTION_SYNONYMS)) {
    if (words.includes(firstWord)) return canonical;
  }
  return null;
}

function commanderModule(bot, mcData, defaultMove, config, addLog, botState) {
  const ownerName = (config.owner || "").toLowerCase().trim();
  if (!ownerName) {
    addLog("[Commander] No owner set in settings.json - module disabled.");
    return;
  }

  // Separate Movements for command tasks (mining/goto) so digging is
  // allowed here without changing how the bot moves while just AFK-idling.
  const taskMove = new Movements(bot, mcData);
  taskMove.canDig = true;
  taskMove.allowFreeMotion = false;

  // ---------- AI BRAIN SETUP (optional) ----------
  let brain = null;
  const aiConf = config.ai || {};
  if (aiConf.enabled) {
    const apiKey = process.env[aiConf.apiKeyEnv || "GEMINI_API_KEY"];
    if (!apiKey) {
      addLog(
        `[Commander] AI is enabled in settings.json but no ${aiConf.apiKeyEnv || "GEMINI_API_KEY"} environment variable was found - falling back to basic commands.`
      );
    } else {
      try {
        const { createBrain } = require("./ai-brain");
        brain = createBrain(apiKey, aiConf.model || "gemini-3.8-flash");
        addLog(`[Commander] AI brain ready (${aiConf.model || "gemini-3.8-flash"}).`);
      } catch (e) {
        addLog(`[Commander] Failed to start AI brain: ${e.message}`);
      }
    }
  }

  let cancelRequested = false;
  let busy = false;

  function setBusy(value) {
    busy = value;
    if (botState) botState.commanderBusy = value;
  }

  function say(msg) {
    if (bot && bot.chat) bot.chat(msg);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function stopEverything() {
    cancelRequested = true;
    setBusy(false);
    try {
      bot.pathfinder.stop();
      bot.pathfinder.setGoal(null);
    } catch (e) {
      /* ignore */
    }
  }

  async function withTask(fn) {
    if (busy) {
      say("I'm already doing something - say stop first if you want to cancel it.");
      return;
    }
    setBusy(true);
    cancelRequested = false;
    try {
      await fn();
    } catch (e) {
      addLog(`[Commander] Task error: ${e.message}`);
      say(`Something went wrong: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function sendHelp() {
    say("Just talk to me normally. Examples:");
    say("'mine 10 stone' / 'mine this' / 'go to 100 65 200' / 'come here' / 'follow me' / 'stop'");
    if (brain) say("Since AI is on, you can also ask for things like 'build me a small stone cottage'.");
  }

  // ---------- MINING ----------
  async function mineBlockByName(blockName, count) {
    const blockDef = mcData.blocksByName[blockName];
    if (!blockDef) {
      say(`I don't know a block called "${blockName}".`);
      return;
    }
    let mined = 0;
    for (let i = 0; i < count; i++) {
      if (cancelRequested) {
        say("Mining cancelled.");
        return;
      }
      const target = bot.findBlock({ matching: blockDef.id, maxDistance: 48 });
      if (!target) {
        say(`Couldn't find any more ${blockName} nearby (mined ${mined}).`);
        return;
      }
      try {
        bot.pathfinder.setMovements(taskMove);
        await bot.pathfinder.goto(new GoalBlock(target.position.x, target.position.y, target.position.z));
        if (cancelRequested) return;
        const freshBlock = bot.blockAt(target.position);
        if (freshBlock && freshBlock.type === blockDef.id) {
          await bot.dig(freshBlock);
          mined++;
        }
      } catch (e) {
        addLog(`[Commander] Mine error: ${e.message}`);
        say(`Couldn't reach that ${blockName}: ${e.message}`);
        return;
      }
    }
    say(`Done - mined ${mined} ${blockName}.`);
  }

  async function mineBlockPlayerLooksAt(playerName) {
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      say("I can't see you right now - get closer.");
      return;
    }
    const block = bot.blockAtEntityCursor(player.entity, 24);
    if (!block || block.name === "air") {
      say("I can't tell which block you're looking at - try naming it instead, like 'mine stone'.");
      return;
    }
    try {
      bot.pathfinder.setMovements(taskMove);
      await bot.pathfinder.goto(new GoalBlock(block.position.x, block.position.y, block.position.z));
      if (cancelRequested) return;
      const freshBlock = bot.blockAt(block.position);
      if (freshBlock && freshBlock.name !== "air") {
        await bot.dig(freshBlock);
        say(`Mined the ${freshBlock.name}.`);
      }
    } catch (e) {
      say(`Couldn't mine that: ${e.message}`);
    }
  }

  // ---------- MOVEMENT ----------
  async function goTo(x, y, z) {
    bot.pathfinder.setMovements(taskMove);
    say(`Heading to ${x}, ${y}, ${z}...`);
    await bot.pathfinder.goto(new GoalNear(x, y, z, 1));
    if (!cancelRequested) say("Arrived.");
  }

  async function comeToOwner(playerName) {
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      say("I can't see you - come closer first.");
      return;
    }
    const pos = player.entity.position;
    bot.pathfinder.setMovements(taskMove);
    say("On my way.");
    await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
    if (!cancelRequested) say("Here.");
  }

  function followOwner(playerName) {
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      say("I can't see you - come closer first.");
      return;
    }
    setBusy(true);
    cancelRequested = false;
    bot.pathfinder.setMovements(taskMove);
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
    say("Following you - say stop when you want me to quit.");
  }

  // ---------- AI-DESIGNED FREEFORM BUILDING ----------
  // Executes via /fill and /setblock (needs the bot to be OP), with hard
  // safety caps applied regardless of what the AI proposed.
  async function runBuildPlan(steps, description) {
    if (!Array.isArray(steps) || steps.length === 0) {
      say("I couldn't come up with a build plan for that.");
      return;
    }
    const origin = bot.entity.position.floored();
    const clip = (v) => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(Number(v) || 0)));

    const commands = [];
    let totalBlocks = 0;
    for (const step of steps.slice(0, MAX_BUILD_STEPS)) {
      const blockName = String(step.block || "").toLowerCase().replace(/^minecraft:/, "");
      if (blockName !== "air" && !mcData.blocksByName[blockName]) {
        addLog(`[Commander] Skipping unknown block "${step.block}" in AI build plan.`);
        continue;
      }
      if (step.type === "fill") {
        const dx1 = clip(step.dx1), dy1 = clip(step.dy1), dz1 = clip(step.dz1);
        const dx2 = clip(step.dx2), dy2 = clip(step.dy2), dz2 = clip(step.dz2);
        const volume = (Math.abs(dx2 - dx1) + 1) * (Math.abs(dy2 - dy1) + 1) * (Math.abs(dz2 - dz1) + 1);
        if (volume > MAX_FILL_VOLUME) {
          addLog(`[Commander] Skipping oversized fill (${volume} blocks) in AI build plan.`);
          continue;
        }
        if (totalBlocks + volume > MAX_TOTAL_BLOCKS) {
          addLog("[Commander] AI build plan hit the total block safety cap - stopping early.");
          break;
        }
        totalBlocks += volume;
        commands.push(
          `/fill ${origin.x + dx1} ${origin.y + dy1} ${origin.z + dz1} ${origin.x + dx2} ${origin.y + dy2} ${origin.z + dz2} minecraft:${blockName}`
        );
      } else if (step.type === "setblock") {
        if (totalBlocks + 1 > MAX_TOTAL_BLOCKS) break;
        totalBlocks += 1;
        const dx = clip(step.dx), dy = clip(step.dy), dz = clip(step.dz);
        commands.push(`/setblock ${origin.x + dx} ${origin.y + dy} ${origin.z + dz} minecraft:${blockName}`);
      }
    }

    if (commands.length === 0) {
      say("I couldn't build that - none of the steps were valid.");
      return;
    }

    say(`${description || "Building..."} (${commands.length} commands, ~${totalBlocks} blocks) - I need to be OP for this to actually appear.`);
    for (const cmd of commands) {
      if (cancelRequested) {
        say("Build cancelled.");
        return;
      }
      bot.chat(cmd);
      await sleep(250);
    }
    if (!cancelRequested) say("Build finished.");
  }

  // ---------- AI PROMPT + DISPATCH ----------
  function buildPrompt(username, message) {
    const pos = bot.entity.position;
    return [
      `You are the "brain" of a Minecraft bot named ${bot.username}, controlled in chat by its owner, ${username}.`,
      `The bot is currently standing at world coordinates x=${Math.floor(pos.x)}, y=${Math.floor(pos.y)}, z=${Math.floor(pos.z)}.`,
      "Decide the single best action for what the owner just said and call exactly one of the provided functions.",
      "For build_structure, design the whole structure yourself using fill (rectangular regions) and setblock (single blocks). Coordinates are offsets (dx,dy,dz) relative to the bot's current position - (0,0,0) is the ground block the bot is standing on, +dy is up. Be creative, but keep it reasonably sized.",
      "If the owner is just chatting, greeting, or asking something that isn't one of the other actions, use chat_reply and answer briefly like a friendly Minecraft player would.",
      "",
      `${username} said: "${message}"`,
    ].join("\n");
  }

  async function handleAiDecision(username, decision) {
    const { name, args } = decision;
    switch (name) {
      case "mine_block": {
        const blockArg = String(args.block_name || "").toLowerCase();
        const count = Math.min(Math.max(parseInt(args.count, 10) || 1, 1), 64);
        if (blockArg === "looking_at" || blockArg === "this" || blockArg === "that") {
          return withTask(() => mineBlockPlayerLooksAt(username));
        }
        return withTask(() => mineBlockByName(blockArg, count));
      }
      case "go_to": {
        const x = Math.round(args.x), y = Math.round(args.y), z = Math.round(args.z);
        if ([x, y, z].some((n) => Number.isNaN(n))) {
          say("I didn't get valid coordinates for that.");
          return;
        }
        return withTask(() => goTo(x, y, z));
      }
      case "come_to_owner":
        return withTask(() => comeToOwner(username));
      case "follow_owner":
        return followOwner(username);
      case "stop":
        stopEverything();
        say("Stopped - back to wandering around.");
        return;
      case "build_structure":
        return withTask(() => runBuildPlan(args.steps, args.description));
      case "chat_reply":
        say(String(args.text || "").slice(0, 250));
        return;
      default:
        addLog(`[Commander] AI returned an unrecognized action "${name}".`);
    }
  }

  // ---------- FALLBACK RULE-BASED PARSER (no AI needed) ----------
  async function handleCommandRuleBased(username, rawMessage) {
    let text = rawMessage.trim();
    if (text.startsWith("!")) text = text.slice(1);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const allTokens = cleaned.split(/\s+/).filter(Boolean);
    if (allTokens.length === 0) return;

    const action = classifyAction(allTokens[0]);
    if (!action) return; // ordinary chat - stay quiet

    const rest = allTokens.slice(1).filter((t) => !FILLERS.has(t));
    const numbers = rest.filter((t) => /^\d+$/.test(t)).map(Number);
    const words = rest.filter((t) => !/^\d+$/.test(t));

    if (action === "help") return sendHelp();

    if (action === "stop") {
      stopEverything();
      say("Stopped - back to wandering around.");
      return;
    }

    if (action === "come") return withTask(() => comeToOwner(username));
    if (action === "follow") return followOwner(username);

    if (action === "goto") {
      const [x, y, z] = numbers;
      if ([x, y, z].some((n) => n === undefined || Number.isNaN(n))) {
        say("Tell me where, like: go to 100 65 200");
        return;
      }
      return withTask(() => goTo(x, y, z));
    }

    if (action === "mine") {
      if (words.includes("this") || words.includes("that") || words.includes("here") || words.length === 0) {
        return withTask(() => mineBlockPlayerLooksAt(username));
      }
      const blockName = words[0];
      const count = Math.min(Math.max(numbers[0] || 1, 1), 64);
      return withTask(() => mineBlockByName(blockName, count));
    }
  }

  // ---------- CHAT LISTENER ----------
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (username.toLowerCase() !== ownerName) return;
    const trimmed = message.trim();
    if (!trimmed) return;

    (async () => {
      if (brain) {
        try {
          const decision = await brain.decide(buildPrompt(username, trimmed), TOOLS);
          if (decision) {
            await handleAiDecision(username, decision);
            return;
          }
        } catch (e) {
          addLog(`[Commander] AI error: ${e.message}`);
          say("My AI brain had a hiccup just now - trying the basic command parser instead.");
        }
      }
      handleCommandRuleBased(username, trimmed).catch((e) => {
        addLog(`[Commander] Unhandled error: ${e.message}`);
      });
    })();
  });

  addLog(`[Commander] Ready for ${config.owner}${brain ? " (AI-powered)" : " (basic commands - AI not configured)"}.`);
}

module.exports = { commanderModule, TOOLS };
