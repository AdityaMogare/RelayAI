import type { Capability, InputViolation, RunResult } from "../core/types.ts";

export function invalidInputResult(
  message: string,
  expected: string,
  observed: string,
  evidencePath: string,
  violations: InputViolation[],
): RunResult {
  return {
    status: "invalid_input",
    code: "INVALID_INPUT",
    message,
    expected,
    observed,
    violations,
    outputs: {},
    evidencePath,
  };
}

export function validateInputs(
  capability: Capability,
  inputs: Record<string, string>,
  evidencePath: string,
): RunResult | undefined {
  const names = new Set(capability.parameters.map((p) => p.name));
  const unknown = Object.keys(inputs).filter((key) => !names.has(key));
  if (unknown.length > 0) {
    const violations: InputViolation[] = unknown.map((key) => ({
      path: `parameters.${key}`,
      expected: names.size > 0 ? `one of ${[...names].join(", ")}` : "no parameters",
      observed: key,
    }));
    return invalidInputResult(
      `Unknown parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      names.size > 0 ? `one of ${[...names].join(", ")}` : "no parameters",
      unknown.join(", "),
      evidencePath,
      violations,
    );
  }
  for (const param of capability.parameters) {
    const value = inputs[param.name];
    const path = `parameters.${param.name}`;
    if (value === undefined || value.trim() === "") {
      const observed = value === undefined ? "not provided" : "empty";
      return invalidInputResult(
        `Missing parameter ${param.name}`,
        path,
        observed,
        evidencePath,
        [{ path, expected: `${param.type}`, observed }],
      );
    }
    if (param.type === "number" && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
      return invalidInputResult(
        `Parameter ${param.name} must be a number`,
        `${path}: number`,
        value,
        evidencePath,
        [{ path, expected: "number", observed: value }],
      );
    }
  }
  return undefined;
}
