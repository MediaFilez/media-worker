import { createReadStream } from "node:fs";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import path from "node:path";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia } from "./storage.js";

export interface R2StorageOptions {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBucket?: string | null;
}

export class R2StorageAdapter implements MediaStorage {
    private readonly client: S3Client;
    constructor(private readonly options: R2StorageOptions) {
        this.client = new S3Client({
            region: "auto",
            endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
        });
    }
    async put(artifact: MediaArtifact, options: { signal?: AbortSignal; public?: boolean } = {}): Promise<StoredMedia> {
        if (options.public && !this.options.publicBucket) throw new Error("Public R2 delivery is not configured.");
        const bucket = options.public ? this.options.publicBucket! : this.options.bucket;
        const day = new Date().toISOString().slice(0, 10);
        const key = `${day}/${crypto.randomUUID()}-${path.basename(artifact.fileName)}`;
        await this.client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: createReadStream(artifact.filePath),
                ContentLength: artifact.sizeBytes,
                ...(artifact.mime ? { ContentType: artifact.mime } : {}),
                ...(options.public ? { ContentDisposition: "inline", CacheControl: "public, max-age=86400" } : {}),
            }),
            { abortSignal: options.signal },
        );
        return {
            key,
            sizeBytes: artifact.sizeBytes,
            contentType: artifact.mime,
            fileName: artifact.fileName,
            location: `r2://${bucket}/${key}`,
        };
    }
    async delete(key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    }
}
