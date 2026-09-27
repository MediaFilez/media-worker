import { config } from "../media-core/config.js";
import { LocalStorageAdapter } from "./local.js";
import { R2StorageAdapter } from "./r2.js";
import type { MediaStorage } from "./storage.js";

export function createDefaultStorage(): MediaStorage {
    const r2 = [config.r2AccountId, config.r2AccessKeyId, config.r2SecretAccessKey, config.r2Bucket];
    if (r2.some(Boolean) && !r2.every(Boolean)) throw new Error("All R2 environment variables must be set together.");
    if (config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket) {
        return new R2StorageAdapter({
            accountId: config.r2AccountId,
            accessKeyId: config.r2AccessKeyId,
            secretAccessKey: config.r2SecretAccessKey,
            bucket: config.r2Bucket,
            publicBucket: config.r2PublicBucket,
        });
    }
    return new LocalStorageAdapter(config.storageDir);
}
