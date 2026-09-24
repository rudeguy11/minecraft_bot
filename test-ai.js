"use strict";

// Quick way to test just the AI understanding - no Minecraft server, no
// mineflayer, nothing. Type messages like you would in-game chat and see
// exactly what the AI decides to do (and its build plans, if it builds
// something), as raw JSON.
//
// Run it with:  node test-ai.js

require("dotenv").config();
const readline = require("readline");
const { createBrain } = require("./ai-brain");
const { TOOLS } = require("./commander");
const config = require("./settings.json");

const apiKeyEnv = (config.ai && config.ai.apiKeyEnv) || "GEMINI_API_KEY";
const apiKey = process.env[apiKeyEnv];
const model = (config.ai && config.ai.model) || "gemini-3.8-flash";

if (!apiKey) {
  console.error(`No ${apiKeyEnv} found. Put it in a .env file first, e.g.:\n${apiKeyEnv}=your_key_here`);
  process.exit(1);
}

const brain = createBrain(apiKey, model);

// A fake position so build_structure offsets have something to be "relative to".
const FAKE_POS = { x: 100, y: 64, z: 200 };

function buildPrompt(message) {
  return [
    `You are the "brain" of a Minecraft bot named TestBot, controlled in chat by its owner, Tester.`,
    `The bot is currently standing at world coordinates x=${FAKE_POS.x}, y=${FAKE_POS.y}, z=${FAKE_POS.z}.`,
    "Decide the single best action for what the owner just said and call exactly one of the provided functions.",
    "For build_structure, design the whole structure yourself using fill (rectangular regions) and setblock (single blocks). Coordinates are offsets (dx,dy,dz) relative to the bot's current position - (0,0,0) is the ground block the bot is standing on, +dy is up. Be creative, but keep it reasonably sized.",
    "If the owner is just chatting, greeting, or asking something that isn't one of the other actions, use chat_reply and answer briefly like a friendly Minecraft player would.",
    "",
    `Tester said: "${message}"`,
  ].join("\n");
}

console.log(`Testing the AI brain with model "${model}" - no Minecraft connection needed.`);
console.log("Type a message as if you were the owner talking in chat. Ctrl+C to quit.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask() {
  rl.question("> ", async (msg) => {
    const trimmed = msg.trim();
    if (!trimmed) return ask();
    try {
      const start = Date.now();
      const decision = await brain.decide(buildPrompt(trimmed), TOOLS);
      const ms = Date.now() - start;
      if (!decision) {
        console.log("(no function call returned)");
      } else {
        console.log(`[${ms}ms] ${decision.name}:`);
        console.log(JSON.stringify(decision.args, null, 2));
      }
    } catch (e) {
      console.error("Error:", e.message);
    }
    console.log("");
    ask();
  });
}

ask();
