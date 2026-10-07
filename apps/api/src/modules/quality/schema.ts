import { z } from "zod";
import { isValidDateString } from "../../lib/date";

export const scanBodySchema = z
  .object({
    minYear: z.coerce.number().int().min(1900).max(2200).optional(),
    maxYear: z.coerce.number().int().min(1900).max(2200).optional(),
    includeOrphanFiles: z.boolean().optional(),
    categories: z.array(z.enum(["DATE", "PHASE", "FILE"])).min(1).max(3).optional(),
  })
  .refine((value) => !value.minYear || !value.maxYear || value.minYear <= value.maxYear, {
    message: "minYear 不能大于 maxYear",
    path: ["minYear"],
  });

export const listFindingsQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED", "ALL"]).default("OPEN"),
  severity: z.enum(["CRITICAL", "WARNING", "INFO"]).optional(),
  category: z.enum(["DATE", "PHASE", "FILE"]).optional(),
  ruleCode: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listReportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

const applyActionSchema = z.union([
  z.object({
    action: z.literal("FIX_DATE"),
    newDate: z.string().refine(isValidDateString, "日期格式应为 YYYY-MM-DD").optional(),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal("SYNC_OBSERVED_AT"),
  }),
  z.object({
    action: z.literal("SET_PHENOPHASE"),
    phenophaseId: z.string().min(1, "请选择物候阶段"),
    speciesId: z.string().min(1).optional(),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({ action: z.literal("QUARANTINE_FILE") }),
  z.object({ action: z.literal("DROP_PHOTO_ROW") }),
  z.object({ action: z.literal("DISMISS"), reason: z.string().trim().max(200).optional() }),
]);

export const applyActionBodySchema = applyActionSchema;

export type ScanBody = z.infer<typeof scanBodySchema>;
export type ListFindingsQuery = z.infer<typeof listFindingsQuerySchema>;
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;
export type ApplyActionBody = z.infer<typeof applyActionSchema>;
