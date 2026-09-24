"use strict";

// Thin wrapper around Google's Gemini "Interactions" API (the current
// function-calling interface as of the @google/genai v2 SDK). Given a prompt
// and a list of tool declarations, it asks Gemini to pick exactly one tool
// and returns { name, args } - or null if something went wrong.

const { GoogleGenAI } = require("@google/genai");

function createBrain(apiKey, model) {
  const client = new GoogleGenAI({ apiKey });

  async function decide(promptText, tools) {
    const interaction = await client.interactions.create({
      model,
      input: promptText,
      tools,
      // "any" forces the model to always call one of our functions (including
      // chat_reply for plain conversation) instead of ever replying with bare
      // text we'd have to parse ourselves.
      generation_config: { tool_choice: "any" },
    });

    const steps = interaction.steps || [];
    const fcStep = steps.find((s) => s.type === "function_call");
    if (!fcStep) return null;
    return { name: fcStep.name, args: fcStep.arguments || {} };
  }

  return { decide };
}

module.exports = { createBrain };
