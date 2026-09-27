import type { MediaArtifact } from "../media-core/types.js";

export interface StoredMedia {
    key: string;
    sizeBytes: number;
    contentType: string | null;
    fileName: string;
    location: string;
}

export interface MediaStorage {
    put(artifact: MediaArtifact, options?: { signal?: AbortSignal; public?: boolean }): Promise<StoredMedia>;
    delete(key: string): Promise<void>;
}
