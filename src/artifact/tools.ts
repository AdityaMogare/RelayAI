import type { Capability } from "../core/types.ts";

export type ToolFunction = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: "string" | "number"; description?: string }>;
      required: string[];
      additionalProperties: false;
    };
  };
};

/** OpenAI-style function-calling schema generated from a recorded capability. */
export function capabilityToTool(capability: Capability): ToolFunction {
  const properties: ToolFunction["function"]["parameters"]["properties"] = {};
  for (const param of capability.parameters) {
    properties[param.name] = {
      type: param.type === "number" ? "number" : "string",
      description: param.description,
    };
  }
  return {
    type: "function",
    function: {
      name: capability.id.replace(/-/g, "_"),
      description: `${capability.description} Returns ${capability.outputs.map((o) => `${o.name}:${o.type}`).join(", ") || "no outputs"}.`,
      parameters: {
        type: "object",
        properties,
        required: capability.parameters.map((p) => p.name),
        additionalProperties: false,
      },
    },
  };
}

export function catalogTools(capabilities: Capability[]): ToolFunction[] {
  return capabilities.map(capabilityToTool);
}
