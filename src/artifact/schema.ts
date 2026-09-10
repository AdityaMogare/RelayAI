import { z } from "zod";
import type { Capability } from "../core/types.ts";

export const locatorSchema = z.object({
  by: z.enum(["role", "label", "text", "css"]),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  selector: z.string().optional(),
});

export const targetSchema = z.object({
  primary: locatorSchema,
  fallbacks: z.array(locatorSchema).optional(),
});

export const checkpointSchema = z.object({
  kind: z.enum(["urlIncludes", "textIncludes", "titleIncludes"]),
  expect: z.string().min(1),
});

export const exceptionalStateSchema = z.object({
  detect: z.object({
    textIncludes: z.string().optional(),
    dialogTitle: z.string().optional(),
    urlIncludes: z.string().optional(),
  }),
  classify: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  code: z.string().min(1),
  message: z.string().min(1),
  recoverAction: z
    .object({
      action: z.enum(["dismiss", "wait"]),
      target: targetSchema.optional(),
      ms: z.number().optional(),
    })
    .optional(),
});

export const capabilitySchema: z.ZodType<Capability> = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  app: z.object({
    vendorId: z.string().min(1),
    surfaceKind: z.enum(["web", "legacy-web", "desktop"]),
  }),
  parameters: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(["string", "number"]),
      description: z.string().optional(),
      sensitive: z.boolean().optional(),
    }),
  ),
  outputs: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(["string", "money"]),
      description: z.string().optional(),
      locator: targetSchema,
    }),
  ),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      action: z.enum(["navigate", "click", "type", "select", "extract", "dismiss", "wait"]),
      target: targetSchema.optional(),
      value: z.string().optional(),
      inputFrom: z.string().optional(),
      url: z.string().optional(),
      outputName: z.string().optional(),
      risk: z.enum(["safe", "risky"]),
      checkpoint: checkpointSchema.optional(),
      note: z.string().optional(),
    }),
  ),
  exceptionalStates: z.array(exceptionalStateSchema),
  success: z.object({
    checkpoint: checkpointSchema,
  }),
});

export function parseCapability(data: unknown): Capability {
  return capabilitySchema.parse(data);
}

export const VENDOR_EXCEPTIONS = [
  {
    detect: { textIncludes: "Member not found" },
    classify: "business_outcome" as const,
    code: "MEMBER_NOT_FOUND",
    message: "No member record matches the supplied ID.",
  },
  {
    detect: { textIncludes: "Permission denied" },
    classify: "business_outcome" as const,
    code: "PERMISSION_DENIED",
    message: "The operator is not authorized to view this member.",
  },
  {
    detect: { textIncludes: "Member ID is required" },
    classify: "business_outcome" as const,
    code: "VALIDATION_ERROR",
    message: "The form rejected the input.",
  },
  {
    detect: { dialogTitle: "System Notice" },
    classify: "recoverable" as const,
    code: "SYSTEM_NOTICE",
    message: "A known interstitial is blocking the work area.",
    recoverAction: {
      action: "dismiss" as const,
      target: {
        primary: { by: "role" as const, role: "button", name: "Dismiss" },
      },
    },
  },
  {
    detect: { textIncludes: "Session expired" },
    classify: "hard_failure" as const,
    code: "SESSION_EXPIRED",
    message: "The teller session expired and cannot continue safely.",
  },
];

export const DISPUTE_EXCEPTIONS = [
  {
    detect: { textIncludes: "Dispute not found" },
    classify: "business_outcome" as const,
    code: "DISPUTE_NOT_FOUND",
    message: "No dispute matches the supplied ID for this member.",
  },
  {
    detect: { textIncludes: "Dispute already filed" },
    classify: "business_outcome" as const,
    code: "DISPUTE_ALREADY_FILED",
    message: "This dispute was already submitted and cannot be filed again.",
  },
  {
    detect: { textIncludes: "Dispute ID is required" },
    classify: "business_outcome" as const,
    code: "VALIDATION_ERROR",
    message: "The dispute queue rejected the input.",
  },
  {
    detect: { textIncludes: "Reason is required" },
    classify: "business_outcome" as const,
    code: "VALIDATION_ERROR",
    message: "The file-dispute form rejected the input.",
  },
];
