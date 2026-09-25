import { cleanupStaleTempDirs } from "../media-core/utils/temp.js";

export async function executeCleanupJob(rootDir?: string): Promise<number> {
    return await cleanupStaleTempDirs(rootDir ? { rootDir } : {});
}
