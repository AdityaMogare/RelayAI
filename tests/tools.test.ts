import { describe, expect, it } from "vitest";
import { capabilityToTool } from "../src/artifact/tools.ts";
import { LOOKUP_MEMBER_SAVINGS } from "./fixtures.ts";

describe("catalog tool schema", () => {
  it("emits an OpenAI function definition from a capability", () => {
    const tool = capabilityToTool(LOOKUP_MEMBER_SAVINGS);
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("lookup_member_savings");
    expect(tool.function.parameters.required).toEqual(["memberId"]);
    expect(tool.function.parameters.properties.memberId?.type).toBe("string");
    expect(tool.function.description).toMatch(/savingsBalance:money/);
  });
});
