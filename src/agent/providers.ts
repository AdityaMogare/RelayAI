import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LlmClient, LlmIdentity, LlmTurn, AgentDecision } from "../core/llm.ts";
import type { Observation } from "../core/types.ts";

const TOOLS = [
  {
    name: "click",
    description: "Click a control identified by accessibility role+name or a ref from the snapshot.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "type",
    description: "Type into a field. Use the literal value needed for this run.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        reason: { type: "string" },
      },
      required: ["text", "reason"],
    },
  },
  {
    name: "select",
    description: "Choose an option from a select/combobox by visible label.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        reason: { type: "string" },
      },
      required: ["text", "reason"],
    },
  },
  {
    name: "extract",
    description: "Read visible text from a labeled control and store it as an output.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" },
        name: { type: "string" },
        outputName: { type: "string" },
        reason: { type: "string" },
      },
      required: ["outputName", "reason"],
    },
  },
  {
    name: "dismiss",
    description: "Dismiss a known interstitial or dialog.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "finish",
    description: "Goal is met (or a known business outcome is on screen). Return extracted outputs.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        outputs: { type: "object", additionalProperties: { type: "string" } },
        businessCode: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "escalate",
    description: "You are stuck or the next action is unsafe. Hand control to a human.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
] as const;

const SYSTEM = `You operate a credit-union back-office console through its accessibility tree.
You are discovering a flow that will later be replayed without you.

Rules:
- Prefer role + accessible name. Never invent CSS selectors.
- One tool call per turn.
- Type and select exact values from the goal (member ID, dispute ID, reason).
- For table fields, extract the data cell (role "cell"), not the rowheader. The value is the amount/text in that cell, not the label.
- Type identifiers into labeled fields (Member ID, Dispute ID). Do not click a table row to open a record — that will not replay with a different ID.
- On a queue/list, type the ID and Open the record before extracting. Extract Transaction Amount only from the dispute detail, not the queue.
- Extract only labeled fields (Savings Balance, Transaction Amount, Confirmation). Never use a dollar amount as the accessible name.
- Finish only when the whole goal is done. If the goal is only to read a balance, extract then finish. If it also asks to file, open, or confirm, keep going after extracts.
- When you see Confirmation, "Dispute filed", or "Sub-account opened", extract that status then finish. Do not dismiss after success.
- Do not extract the same control twice.
- Confirm / Delete / Approve are irreversible. Still click them so the step is recorded; the runtime may pause for a human first.
- If you see "Member not found", "Permission denied", "Dispute not found", or "Dispute already filed", finish with a businessCode.
- If you see "System Notice", dismiss it.
- If you cannot proceed safely, escalate.
- Stay on the current origin.`;

function formatObs(observation: Observation): string {
  const refs = observation.refs.map((r) => `[${r.ref}] ${r.role} "${r.name}"`).join("\n");
  return `URL: ${observation.url}
Title: ${observation.title}
Dialog: ${observation.dialog ?? "(none)"}
Accessibility tree:
${observation.aria}

Interactive refs:
${refs || "(none)"}`;
}

function toDecision(tool: string, input: Record<string, unknown>): AgentDecision {
  return {
    tool: tool as AgentDecision["tool"],
    ref: asString(input.ref),
    role: asString(input.role),
    name: asString(input.name),
    text: asString(input.text),
    value: asString(input.text),
    outputName: asString(input.outputName),
    reason: asString(input.reason) ?? "unspecified",
    outputs: (input.outputs as Record<string, string> | undefined) ?? undefined,
    businessCode: asString(input.businessCode),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class AnthropicClient implements LlmClient {
  readonly identity: LlmIdentity;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.RELAY_MODEL) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for live discovery.");
    this.client = new Anthropic({ apiKey });
    this.model = model ?? "claude-sonnet-4-20250514";
    this.identity = { provider: "anthropic", model: this.model, scripted: false };
  }

  async decide(input: {
    goal: string;
    observation: Observation;
    history: string[];
    remainingSteps: number;
  }): Promise<LlmTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS as unknown as Anthropic.Tool[],
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content: `Goal: ${input.goal}\nRemaining steps: ${input.remainingSteps}\nRecent actions:\n${input.history.join("\n") || "(none)"}\n\n${formatObs(input.observation)}`,
        },
      ],
    });
    const tool = response.content.find((block) => block.type === "tool_use");
    if (!tool || tool.type !== "tool_use") {
      throw new Error("Model returned no tool call.");
    }
    return { decision: toDecision(tool.name, tool.input as Record<string, unknown>), raw: tool };
  }
}

export class OpenAIClient implements LlmClient {
  readonly identity: LlmIdentity;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey = process.env.OPENAI_API_KEY, model = process.env.RELAY_MODEL) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for live discovery.");
    this.client = new OpenAI({ apiKey });
    this.model = model ?? "gpt-4o";
    this.identity = { provider: "openai", model: this.model, scripted: false };
  }

  async decide(input: {
    goal: string;
    observation: Observation;
    history: string[];
    remainingSteps: number;
  }): Promise<LlmTurn> {
    const tools = TOOLS.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
    const response = await this.client.chat.completions.create({
      model: this.model,
      tool_choice: "required",
      tools,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Goal: ${input.goal}\nRemaining steps: ${input.remainingSteps}\nRecent actions:\n${input.history.join("\n") || "(none)"}\n\n${formatObs(input.observation)}`,
        },
      ],
    });
    const call = response.choices[0]?.message.tool_calls?.[0];
    if (!call || call.type !== "function") throw new Error("Model returned no tool call.");
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    return { decision: toDecision(call.function.name, args), raw: call };
  }
}

export class ScriptedLlm implements LlmClient {
  readonly identity: LlmIdentity = { provider: "scripted", model: "scripted", scripted: true };

  constructor(private readonly decisions: AgentDecision[]) {}

  async decide(): Promise<LlmTurn> {
    const decision = this.decisions.shift();
    if (!decision) throw new Error("Scripted LLM exhausted.");
    return { decision };
  }
}

export function createLlmClient(): LlmClient {
  const provider = (process.env.RELAY_LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).toLowerCase();
  if (provider === "openai") return new OpenAIClient();
  return new AnthropicClient();
}
