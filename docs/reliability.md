# Reliability and isolation

## Controls in the worker

HTTP validation rejects credentials and private/reserved IPv4 and IPv6 destinations. Direct HTTP and the fetch transport validate each redirect and check DNS again when connecting. The native extractor proxy resolves and checks all addresses, then connects to a verified literal address. Redirect-generated HTTP requests and HTTPS CONNECT destinations pass through the same policy. Proxy credentials are random and scoped to one engine invocation; closure destroys active sockets.

YouTube.js uses the guarded fetch implementation for session, player, metadata and media requests. Fetches combine request and job signals, limit request bodies to 4 MiB, bound decoded response bytes, and strip authorization and cookies on cross-origin redirects. yt-dlp and gallery-dl receive explicit proxy arguments and proxy environment variables, with exclusions cleared. gallery-dl ignores ambient config and passes proxy and quality options to nested yt-dlp. FFmpeg and FFprobe only allow `file` and `pipe` protocols for worker-owned processing. Tool environments omit Redis, R2 and Cobalt credentials.

Cobalt discovery is untrusted and public-only. Operator-configured API endpoints are trusted exceptions. Their API credential stays on the configured POST request, whose redirects are refused. Returned private tunnel URLs must match the configured origin, including scheme and port. Public tunnel redirects are checked normally. A configured private Cobalt service remains an intentional network exception. Configure only services you trust. The worker cannot constrain outbound requests made on a remote Cobalt server.

Temporary bytes are sampled every `TEMP_MONITOR_INTERVAL_MS` (250 ms by default), across the job directory and local storage staging directories. Over-limit jobs abort and terminate their launched tools. Local uploads stream with cancellation and check the aggregate budget before commit. `MAX_JOB_TEMP_SIZE` defaults to 20 GiB. Sampling can overshoot between checks and does not bound persistent stored media. It is not a filesystem quota.

Each job has `MAX_JOB_PROCESSES` launch slots (default 2). Tools have wall-clock deadlines, bounded output and tree termination. Job completion reaps any tracked child still running. On Linux, `prlimit` adds inherited per-process CPU time and per-file size limits. `PROCESS_CPU_SECONDS` defaults to 1200, and the file ceiling uses `MAX_JOB_TEMP_SIZE`. Missing `prlimit` prevents tool execution when `LINUX_PROCESS_LIMITS=true`. These limits do not enforce aggregate memory or count every descendant.

## Required deployment isolation

The proxy is an application control, not an OS sandbox. Do not expose native extraction to untrusted producers until proxy bypass is blocked and tested. Ordinary Docker networking and joining API/engine networks do not provide this guarantee.

On Linux, run extractor trees under a distinct UID or cgroup in a restricted network namespace. Host nftables or cgroup egress rules should allow only the guarded proxy listener from that identity and deny other outbound traffic, including DNS, IPv6, UDP, loopback services, host gateways and metadata addresses. The application identity needs separately scoped access to Redis, R2 and configured Cobalt. Do not apply those exceptions to the extractor identity. This requires a launcher and host networking configuration; the repository does not install them. Rules that merely block RFC1918 IPv4 ranges are insufficient.

Assign each job a cgroup v2 with memory and PID limits and a disk quota or bounded dedicated filesystem before starting native tools. Container-wide limits are useful protection for the host but jobs still share them. Production Compose configures 4 GiB memory, two CPUs and 128 PIDs for the whole worker, with a 45-second stop grace period. Size these against measured workload and concurrency. Store persistent local output on a durable volume when using local storage.

On Windows, use a supervised restricted process token or sandbox, Windows Filtering Platform enforcement scoped to the extractor identity, and Job Objects for memory and descendant limits. Simple proxy arguments or a broad firewall exception for Node do not provide isolation. These Windows controls are not implemented here. Prefer the isolated Linux deployment for untrusted production jobs. Validate allowed public downloads, private redirects, rebinding and auxiliary process bypass in the deployed environment.

Linux resource behavior follows [prlimit](https://www.man7.org/linux/man-pages/man1/prlimit.1.html). Native proxy options follow the [yt-dlp documentation](https://github.com/yt-dlp/yt-dlp#network-options) and [gallery-dl configuration](https://gdl-org.github.io/docs/configuration.html). Infrastructure recipes here describe required controls, not verified host configuration.

## Storage recovery

The stable key hashes `[jobId, role]`, with separate `original`, `thumbnail` and `archive` roles. A fingerprint of the parsed runtime job is stored alongside the result. Do not reuse job IDs for different input. Producers must provide a globally unique, trusted job ID within each storage bucket/root. Version 1 inputs and results are unchanged. Bucket routing is part of the recovery scope; conflicting reuse across different buckets is not globally detected.

Local storage commits the artifact and metadata together through a directory rename. R2 uses `If-None-Match: *` and checks HEAD after an uncertain write. A retry returns the existing result before extracting again. Concurrent deliveries may do duplicate download work, but their storage writes cannot overwrite the winning result. Only that original commit's winner creates a preview from its local artifact. A crash before preview creation can leave an original without a preview; recovery treats the preview as optional.

Cloudflare documents conditional PutObject support in its [S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/) and [strong consistency model](https://developers.cloudflare.com/r2/reference/consistency/). Live R2 behavior still needs a disposable-bucket integration check. Failed or uncertain writes are not blindly deleted: another delivery may own that object. Stable keys make these results discoverable by retry. Local failed staging is removed; a later adapter startup removes abandoned staging only when its same-host ownership probe proves the creating process is gone. Staging from another host and legacy UUID objects require operator retention review.

Cancellation before commit leaves no complete local result. Cancellation or process death after a storage commit can leave an object whose queue job failed or lost acknowledgement. Its stable identity supports recovery; retention must cover it. Explicit deletion removes the idempotency record too, so later redelivery can create it again. Tombstones and full result timestamps are not persisted. Power-loss durability of local rename metadata is not claimed.

Use `delete(key, { public: true })` for both public originals and previews, and default `delete(key)` for private objects. R2 results still carry keys rather than public delivery URLs. This pass adds no delivery API or CDN service.

## Queue operation and quality

Cancellation GETs are serial. The control client disables offline command queuing and uses a two-second command timeout with bounded per-request retries. Control failure aborts the job with a retryable infrastructure error; an explicit cancellation is permanent. Progress reporting keeps at most one pending write per delivery, skips intermediate updates while it is pending, and cannot block execution or acknowledgement. There is no post-commit deletion of control keys. Producers must set cancellation keys with a TTL and keep the flag alive for the intended cancellation period. Shutdown aborts active jobs, stops new executions and waits up to `SHUTDOWN_GRACE_MS` (30 seconds); a stuck Redis acknowledgement forces process exit so the supervisor can recover it. BullMQ retry attempts are capped by `MAX_JOB_ATTEMPTS`, even if a producer requests more.

`best` retains the engine's best available media. Explicit heights prefer the highest available format at or below that height where the engine exposes variants. yt-dlp, nested gallery-dl yt-dlp and YouTube.js retain a best-format fallback when no suitable variant exists. Cobalt receives the explicit requested height. Direct media and native gallery extractors may offer only one rendition, so quality is a selection preference, not a hard output-resolution guarantee. `audio-only` selects audio processing in every path. An already valid MP3 passes through if it fits the requested byte limit. Changed processing outputs require signature and stream/type validation. Unchanged file probes are cached only within a job and invalidated by size or timestamp changes.

Default regression tests use local fixtures. `pnpm run test:redis` uses only an explicitly configured `TEST_REDIS_URL`, random keys and its own queue. Use a disposable Redis server. Public-platform and live R2 checks remain deployment tests.

## Instagram collections

Instagram downloads preserve every resolved photo and video, up to 50 artifacts. `MediaArtifact.items` carries a collection in Core; single artifacts keep their existing shape. Aggregate source bytes must fit the job's download limit. A failed child transfer cannot be recovered as a successful first slide. Mixed VideoDropper posts follow the provider's video and image arrays, which do not expose the original combined slide order.

Version 1 download results add optional `items: StoredMedia[]`; `output` still identifies the first file. The API must persist each item and expose its own file ID. Batch ZIP jobs flatten a post's artifacts into the archive.

Each sibling has a stable create-only storage identity. The primary is written last with `collectionSize` metadata and acts as the collection commit marker. Retries recover every sibling from that marker, including when the primary upload committed but its acknowledgement was lost. Existing single-file storage records are unchanged. An old completed job remains its original result; submit a new job to retrieve a full album.
