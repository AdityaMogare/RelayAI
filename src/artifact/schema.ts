import { z } from "zod";
import { ArtifactSchemaError } from "../core/errors.ts";
import type { Capability } from "../core/types.ts";
import { CURRENT_SCHEMA_VERSION } from "./defaults.ts";
import { migrate, UnsupportedSchemaError } from "./migrate.ts";

export const locatorScopeSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("row"),
    hasText: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    by: z.literal("region"),
    heading: z.string().min(1),
  }),
]);

export const locatorSchema = z.object({
  by: z.enum(["role", "label", "text", "css", "cellInRow"]),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  selector: z.string().optional(),
  scope: locatorScopeSchema.optional(),
  row: z.object({ matches: z.string().min(1) }).optional(),
  cell: z.string().min(1).optional(),
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
    locatorMiss: z.boolean().optional(),
  }),
  classify: z.enum(["business_outcome", "recoverable", "transient", "hard_failure", "needs_human"]),
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
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
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
      pii: z.boolean().optional(),
    }),
  ),
  auth: z
    .object({
      credentialRef: z.string().min(1),
    })
    .optional(),
  approval: z
    .object({
      requestedBy: z.string().min(1),
      approvedBy: z.string().min(1),
      approvedAt: z.string().min(1),
    })
    .optional(),
  sideEffects: z.object({
    kind: z.enum(["none", "creates", "mutates", "irreversible"]),
    compensation: z.string().min(1),
  }),
  preconditions: z.object({
    requiresSession: z.boolean(),
    requiresRole: z.string().min(1).optional(),
    entryCheckpoint: checkpointSchema,
  }),
  uses: z.array(
    z.object({
      capabilityId: z.string().min(1),
      pass: z.array(z.string().min(1)),
    }),
  ),
  provenance: z.object({
    discoveredAt: z.string().min(1),
    discoveredBy: z.enum(["model", "human"]),
    model: z.string().optional(),
    promptHash: z.string().optional(),
    evidenceRunId: z.string().optional(),
    goal: z.string().min(1).optional(),
    assistedBy: z.string().min(1).optional(),
  }),
  idempotencyKeyFrom: z.array(z.string().min(1)).optional(),
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
      antiCheckpoints: z.array(checkpointSchema).optional(),
      note: z.string().optional(),
    timeoutMs: z.number().int().positive(),
    retryBudget: z.number().int().nonnegative(),
    assistedBy: z.string().min(1).optional(),
  }),
  ),
  exceptionalStates: z.array(exceptionalStateSchema),
  antiCheckpoints: z.array(checkpointSchema).optional(),
  success: z.object({
    checkpoint: checkpointSchema,
  }),
});

export function parseCapability(data: unknown): Capability {
  try {
    return capabilitySchema.parse(migrate(data));
  } catch (err) {
    if (err instanceof UnsupportedSchemaError || err instanceof ArtifactSchemaError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ArtifactSchemaError(message, err);
  }
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
    classify: "needs_human" as const,
    code: "SESSION_EXPIRED",
    message: "The teller session expired and cannot continue safely.",
  },
  {
    detect: { textIncludes: "temporarily unavailable" },
    classify: "transient" as const,
    code: "CORE_UNAVAILABLE",
    message: "The servicing host is temporarily unavailable.",
    recoverAction: { action: "wait" as const, ms: 200 },
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
    detect: { locatorMiss: true, urlIncludes: "/disputes" },
    classify: "business_outcome" as const,
    code: "DISPUTE_NOT_FOUND",
    message: "No queue row matched merchant + last4 for this member.",
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
