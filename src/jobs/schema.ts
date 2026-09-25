import { z } from "zod";
import { outputTypes, qualityVariants } from "../media-core/types.js";

const id = z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9._:-]+$/);
const output = z
    .object({
        type: z.enum(outputTypes).default("auto"),
        format: z.enum(["original", "mp4", "mp3", "jpg"]).default("original"),
        quality: z.enum(qualityVariants).default("best"),
        maxBytes: z
            .number()
            .int()
            .positive()
            .max(100 * 1024 ** 3)
            .optional(),
        allowCompression: z.boolean().default(false),
    })
    .default({ type: "auto", format: "original", quality: "best", allowCompression: false });

export const downloadJobSchema = z.object({
    type: z.literal("download"),
    jobId: id,
    url: z.url({ protocol: /^https?$/ }),
    output,
    maxDownloadBytes: z
        .number()
        .int()
        .positive()
        .max(100 * 1024 ** 3)
        .optional(),
});

export const batchJobSchema = z.object({
    type: z.literal("batch"),
    jobId: id,
    items: z
        .array(downloadJobSchema.omit({ type: true, jobId: true }))
        .min(1)
        .max(100),
    archiveName: z.string().trim().min(1).max(160).default("media.zip"),
});

export const cleanupJobSchema = z.object({
    type: z.literal("cleanup"),
    jobId: id,
});

export const workerJobSchema = z.discriminatedUnion("type", [downloadJobSchema, batchJobSchema, cleanupJobSchema]);

export type DownloadJob = z.infer<typeof downloadJobSchema>;
export type BatchJob = z.infer<typeof batchJobSchema>;
export type CleanupJob = z.infer<typeof cleanupJobSchema>;
export type WorkerJob = z.infer<typeof workerJobSchema>;
