import { z } from "zod";
import { isValidDateString } from "../../lib/date";
import { ACTION_KINDS, FINDING_CATEGORIES } from "./rules";

export const scanQuerySchema = z.object({
  categories: z
    .string()
    .optional()
    .transform((value) => (value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : []))
    .pipe(z.array(z.enum(FINDING_CATEGORIES))),
  referenceDate: z.string().refine(isValidDateString, "日期格式应为 YYYY-MM-DD").optional(),
});

export const executeActionSchema = z.object({
  action: z.enum(ACTION_KINDS),
  fingerprints: z.array(z.string().regex(/^[0-9a-f]{16}$/, "无效的发现指纹")).min(1).max(500),
});

export const actionIdParamsSchema = z.object({
  actionId: z.string().uuid("无效的处置 ID"),
});

export type ScanQuery = z.infer<typeof scanQuerySchema>;
export type ExecuteActionInput = z.infer<typeof executeActionSchema>;
