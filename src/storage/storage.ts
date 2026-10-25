import type { MediaArtifact } from "../media-core/types.js";

export interface StoredMedia {
    collectionSize?: number;
    key: string;
    thumbnailKey?: string;
    sizeBytes: number;
    contentType: string | null;
    fileName: string;
    location: string;
}

export interface MediaStorage {
    put(artifact: MediaArtifact, options?: StorageOptions): Promise<StoredMedia>;
    find?(options: StorageOptions & { identity: StorageIdentity }): Promise<StoredMedia | null>;
    delete(key: string, options?: { public?: boolean; signal?: AbortSignal }): Promise<void>;
}

export interface StorageIdentity {
    jobId: string;
    role: "original" | "thumbnail" | "archive";
    fingerprint: string;
}

export interface StorageOptions {
    signal?: AbortSignal;
    public?: boolean;
    identity?: StorageIdentity;
    onCreated?: () => void;
}
