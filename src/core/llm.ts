import type { Observation } from "./types.ts";

export type AgentToolName = "click" | "type" | "select" | "extract" | "dismiss" | "finish" | "escalate";

export type AgentDecision = {
  tool: AgentToolName;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  outputName?: string;
  reason: string;
  outputs?: Record<string, string>;
  businessCode?: string;
};

export type LlmTurn = {
  decision: AgentDecision;
  raw?: unknown;
};

export type LlmIdentity = {
  provider: string;
  model: string;
  scripted: boolean;
};

export interface LlmClient {
  readonly identity: LlmIdentity;
  decide(input: {
    goal: string;
    observation: Observation;
    history: string[];
    remainingSteps: number;
  }): Promise<LlmTurn>;
}
