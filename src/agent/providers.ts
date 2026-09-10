import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { LlmError, MissingApiKeyError } from "../core/errors.ts";
import type { LlmClient, LlmIdentity, LlmTurn, AgentDecision } from "../core/llm.ts";
import type { Observation } from "../core/types.ts";
import { DISCOVERY_SYSTEM_PROMPT } from "./prompt.ts";

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
    if (!apiKey) throw new MissingApiKeyError("ANTHROPIC_API_KEY");
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
    const started = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: DISCOVERY_SYSTEM_PROMPT,
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
      throw new LlmError("Model returned no tool call.");
    }
    return {
      decision: toDecision(tool.name, tool.input as Record<string, unknown>),
      raw: tool,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - started,
      },
    };
  }
}

export class OpenAIClient implements LlmClient {
  readonly identity: LlmIdentity;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey = process.env.OPENAI_API_KEY, model = process.env.RELAY_MODEL) {
    if (!apiKey) throw new MissingApiKeyError("OPENAI_API_KEY");
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
    const started = Date.now();
    const response = await this.client.chat.completions.create({
      model: this.model,
      tool_choice: "required",
      tools,
      messages: [
        { role: "system", content: DISCOVERY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Goal: ${input.goal}\nRemaining steps: ${input.remainingSteps}\nRecent actions:\n${input.history.join("\n") || "(none)"}\n\n${formatObs(input.observation)}`,
        },
      ],
    });
    const call = response.choices[0]?.message.tool_calls?.[0];
    if (!call || call.type !== "function") throw new LlmError("Model returned no tool call.");
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    return {
      decision: toDecision(call.function.name, args),
      raw: call,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      },
    };
  }
}

export class ScriptedLlm implements LlmClient {
  readonly identity: LlmIdentity = { provider: "scripted", model: "scripted", scripted: true };

  constructor(private readonly decisions: AgentDecision[]) {}

  async decide(): Promise<LlmTurn> {
    const decision = this.decisions.shift();
    if (!decision) throw new LlmError("Scripted LLM exhausted.");
    return { decision };
  }
}

export function createLlmClient(opts?: { provider?: string; model?: string }): LlmClient {
  const provider = (
    opts?.provider ??
    process.env.RELAY_LLM_PROVIDER ??
    (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")
  ).toLowerCase();
  const model = opts?.model ?? process.env.RELAY_MODEL;
  if (provider === "openai") return new OpenAIClient(process.env.OPENAI_API_KEY, model);
  return new AnthropicClient(process.env.ANTHROPIC_API_KEY, model);
}
