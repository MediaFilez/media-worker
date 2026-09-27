import { z } from "zod";
import { downloadJobSchema, type DownloadJob } from "./schema.js";

export const apiDownloadJobSchema = downloadJobSchema.extend({
    contractVersion: z.literal(1),
    userId: z.string().nullable(),
});

export type ApiDownloadJob = z.infer<typeof apiDownloadJobSchema>;

export function parseApiDownloadJob(input: unknown): { payload: ApiDownloadJob; runtimeJob: DownloadJob } {
    const payload = apiDownloadJobSchema.parse(input);
    return {
        payload,
        runtimeJob: {
            type: payload.type,
            jobId: payload.jobId,
            url: payload.url,
            delivery: payload.delivery,
            output: payload.output,
            maxDownloadBytes: payload.maxDownloadBytes,
        },
    };
}
