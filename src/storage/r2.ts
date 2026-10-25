import { createReadStream } from "node:fs";
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import path from "node:path";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia, StorageOptions, StorageIdentity } from "./storage.js";
import { identityKey, assertFingerprint } from "./identity.js";

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
        if (options.publicBucket === options.bucket) throw new Error("Public and private R2 buckets must be distinct.");
        this.client = new S3Client({
            region: "auto",
            endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
        });
    }
    private bucket(isPublic?: boolean): string {
        if (isPublic && !this.options.publicBucket) throw new Error("Public R2 delivery is not configured.");
        return isPublic ? this.options.publicBucket! : this.options.bucket;
    }

    async find(options: StorageOptions & { identity: StorageIdentity }): Promise<StoredMedia | null> {
        options.signal?.throwIfAborted();
        const bucket = this.bucket(options.public);
        const key = identityKey(options.identity);
        let object;
        try {
            object = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: options.signal });
        } catch (error) {
            if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
            throw error;
        }
        assertFingerprint(object.Metadata?.fingerprint, options.identity);
        if (!object.ContentLength || !object.Metadata?.filename) throw new Error("The stored job result is incomplete.");
        const collectionSize = object.Metadata.collectionsize ? Number(object.Metadata.collectionsize) : undefined;
        if (collectionSize !== undefined && (!Number.isSafeInteger(collectionSize) || collectionSize < 2 || collectionSize > 50))
            throw new Error("The stored collection metadata is invalid.");
        return {
            key,
            sizeBytes: object.ContentLength,
            contentType: object.ContentType ?? null,
            fileName: Buffer.from(object.Metadata.filename, "base64url").toString("utf8"),
            location: `r2://${bucket}/${key}`,
            ...(collectionSize ? { collectionSize } : {}),
        };
    }

    async put(artifact: MediaArtifact, options: StorageOptions = {}): Promise<StoredMedia> {
        options.signal?.throwIfAborted();
        const bucket = this.bucket(options.public);
        if (options.identity) {
            const existing = await this.find({ ...options, identity: options.identity });
            if (existing) return existing;
        }
        const day = new Date().toISOString().slice(0, 10);
        const key = options.identity ? identityKey(options.identity) : `${day}/${crypto.randomUUID()}-${path.basename(artifact.fileName)}`;
        const body = createReadStream(artifact.filePath);
        try {
            await this.client.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: body,
                    ContentLength: artifact.sizeBytes,
                    ...(options.identity
                        ? {
                              IfNoneMatch: "*",
                              Metadata: {
                                  fingerprint: options.identity.fingerprint,
                                  filename: Buffer.from(artifact.fileName).toString("base64url"),
                                  ...(artifact.collectionSize ? { collectionsize: String(artifact.collectionSize) } : {}),
                              },
                          }
                        : {}),
                    ...(artifact.mime ? { ContentType: artifact.mime } : {}),
                    ...(options.public ? { ContentDisposition: "inline", CacheControl: "public, max-age=86400" } : {}),
                }),
                { abortSignal: options.signal },
            );
            options.onCreated?.();
        } catch (error) {
            // An upload may have committed before the response was lost. Never overwrite it.
            if (options.identity && !options.signal?.aborted) {
                const existing = await this.find({ ...options, identity: options.identity });
                if (existing) return existing;
            }
            throw error;
        } finally {
            body.destroy();
        }
        return {
            key,
            sizeBytes: artifact.sizeBytes,
            contentType: artifact.mime,
            fileName: artifact.fileName,
            location: `r2://${bucket}/${key}`,
            ...(artifact.collectionSize ? { collectionSize: artifact.collectionSize } : {}),
        };
    }
    async delete(key: string, options: { public?: boolean; signal?: AbortSignal } = {}): Promise<void> {
        options.signal?.throwIfAborted();
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(options.public), Key: key }), { abortSignal: options.signal });
    }
}
