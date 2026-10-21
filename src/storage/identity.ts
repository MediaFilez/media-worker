import { createHash } from "node:crypto";
import type { StorageIdentity } from "./storage.js";
import { userError } from "../media-core/utils/errors.js";

export function storageIdentity(job: { jobId: string }, role: StorageIdentity["role"]): StorageIdentity {
    return { jobId: job.jobId, role, fingerprint: createHash("sha256").update(JSON.stringify(job)).digest("hex") };
}

export function identityKey(identity: StorageIdentity): string {
    return `jobs/${createHash("sha256")
        .update(JSON.stringify([identity.jobId, identity.role]))
        .digest("hex")}/artifact`;
}

export function assertFingerprint(actual: string | undefined, identity: StorageIdentity): void {
    if (actual !== identity.fingerprint) {
        throw userError("This job identity already has a different or invalid stored result.", "IDENTITY_CONFLICT", { stopFallback: true });
    }
}
