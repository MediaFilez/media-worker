# MediaFilez Worker

Standalone downloader, processor and storage worker. Keep Discord clients, HTTP frameworks and delivery-specific limits outside Media Core.

- `src/media-core` owns planning, engine adapters, guarded transfers, artifact validation and processing. Preserve the existing JavaScript implementation unless a specific change needs TypeScript.
- `src/runtime.ts` owns whole-execution deadlines, retry attempts and temporary directory cleanup. Cancellation must prevent starting the next stage. Progress is best effort and must never retry committed storage.
- `src/jobs` owns serializable input and orchestration; `src/queue-worker.ts` owns BullMQ and Redis cancellation. Keep queue imports outside Core.
- `src/storage` owns keys and uploads. Stable job identity uses create-only commits; never overwrite a prior result or delete it when an acknowledgement is uncertain. Engines and FFmpeg must not call storage adapters directly.
- Preserve exported Core interfaces and version 1 job/result contracts. Validate incompatible options without accepting raw extractor selectors or caller-controlled storage keys.
- Security-sensitive code: URL/DNS/redirect checks, exact trusted Cobalt origins, cookies, process arguments, signatures, byte limits and owned temporary cleanup. Extractor proxies require OS egress enforcement to prevent bypass. Sampled temporary disk limits require quotas for a hard ceiling. Never relax checks to recover a download.
- Add focused regression tests with local fixtures and mocks. Default tests must not download from public platforms or require credentials. Keep live checks opt-in.
- Use Node >=22.13 and `pnpm@11.25.0` with the existing lockfile. `pnpm run check` runs boundaries, TypeScript build, tests and formatting; there is no separate lint command. Use `pnpm exec tsx --test <files>` for focused tests.
- Do not read or copy `.env` values or cookie contents into reports. Preserve local Git changes. Do not commit, push or deploy without explicit authorization.
