# MediaFilez security policy

**Last reviewed:** November 2, 2026

## Supported code and private reports

Security fixes target the latest release and `main` of the affected bot, API, or worker repository. Older deployments should update before requesting a backport.

Do not open a public issue containing an unpatched vulnerability. Use the affected repository's private vulnerability reporting, where available, or email **security@mediafilez.online** with the subject **"MediaFilez Security Report"**. The bot repository supports [private reporting](https://github.com/RlxChap2/MediaFilez/security/advisories/new).

Include the affected component/version or commit, relevant configuration names without secret values, a minimal local reproduction, expected impact, and a safe remediation idea. Redact tokens, cookies, authorization headers, signed URLs, personal information, and private media. We aim to acknowledge complete reports within seven days; investigation and remediation time depend on severity and reproducibility. Allow a reasonable remediation period before public disclosure.

This reporting policy is not authorization to scan live infrastructure, access other accounts, extract data, disrupt service, or bypass a third party's rules. Use local fixtures and dummy credentials. Ask the relevant operator before testing a live deployment. No bounty or legal safe harbor is promised by this document.

## Ownership and trust boundaries

- **Bot:** Discord commands and reply visibility belong to the interaction layer. Download engines must not upload to Discord or choose delivery fallbacks. An album can require several attachments/replies, so delivery can be partially committed before an error.
- **API:** routes translate HTTP, services enforce business rules/ownership, and PostgreSQL stores durable records. Heavy media execution belongs in the worker. Browser sessions, Bearer credentials, API keys, official presence writer tokens, and presence reader tokens have distinct scopes. Do not treat a missing owner ID as anonymous ownership.
- **Worker:** Core owns planning, guarded transfers, artifact validation, and processing. Runtime owns deadlines/cleanup; storage owns object identity and commits. Preserve versioned job/result contracts and keep queue/storage credentials outside engine code.

The API, Redis producers, worker, storage, and any configured private Cobalt origin are different trust boundaries. Redis and worker job submission must remain private and authenticated; an untrusted party with queue access can supply powerful job options. Public/private visibility must remain explicit through ownership checks, persistence, signing, and storage selection.

## URL and native-tool controls

Treat source URLs, redirect targets, extracted media URLs, Cobalt tunnels, filenames, archives, subprocess arguments, and returned metadata as untrusted. Changes to these paths require SSRF, path traversal, command-injection, credential-disclosure, and resource-limit review.

Use guarded HTTP adapters that validate redirects and DNS again at connection time. Unknown pages/direct URLs must not fall through to arbitrary native extraction. A trust exception for a configured private Cobalt instance is intentional operator authority, not proof that all URLs it returns are safe. Preserve the worker's exact origin checks, including scheme and port. Never forward API credentials to a discovered endpoint or a different origin.

FFmpeg and FFprobe processing must retain the local `file,pipe` protocol restriction. This does not remove local filesystem authority or provide a native-code sandbox. Native extractors and library-driven network access require deployment controls beyond the JavaScript URL validator.

The worker's guarded proxy is an application control. It is not OS egress enforcement. Run extractor trees under a separate restricted identity/network namespace or equivalent sandbox, permit only the guarded proxy from that identity, and block alternative direct traffic including DNS, IPv6, UDP, loopback services, gateways, and metadata endpoints. Keep Redis, database, R2, and private service exceptions on the application identity, not the extractor identity. Ordinary Compose networks and proxy arguments alone do not establish this boundary.

Use per-job memory/PID/CPU limits and filesystem quotas where required. Sampled temporary-directory size limits can overshoot; container-wide resource limits are shared by jobs. Windows process tokens, Job Objects, and identity-scoped network enforcement require operator implementation. The repositories do not automatically install those host controls. Read `docs/reliability.md` in the matching worker distribution for the deployment requirements.

No component promises malware scanning or verification of copyright, source privacy, paywall, or deletion status. Public-network URL validation is not content authorization. Do not relax controls to make a blocked download succeed.

## Relays and source credentials

Source platforms, CDNs, relays, and Cobalt servers receive URLs/options needed for requests. Use only providers whose terms and data practices the operator has reviewed. New external processors need explicit configuration, an opt-out, and updated deployment privacy disclosures. Public discovery remains opt-in and requires acceptance of instance owners' access rules; do not bypass bot challenges or authentication requirements.

Use `INSTAGRAM_PROXY_HOSTS=none` and `REDDIT_PROXY_HOSTS=none` to disable the corresponding embed relays. Defaults differ between the bot and worker. Disabling those relays does not disable source-platform/CDN access or separately configured Cobalt. Grabfy is disabled by default with `GRABFY_ENABLED=false`; when explicitly enabled it is preferred for Instagram posts/Reels. Its resolver uses a fixed HTTPS endpoint, guarded DNS, a bounded JSON body and a resolution timeout, and refuses resolver redirects. Every returned media URL and redirect still passes guarded transfer/type/count/aggregate-size checks; operator trust exceptions are not inherited. No browser cookies or application credentials are sent to the resolver. Provider text and signed links must not appear in diagnostic messages.

Grabfy is an unverified external processor, not an audited trusted service. Review its personal-use terms and obtain permission for the intended service/API use before enabling it. A successful download, HTTPS certificate, or absent threat-intelligence match does not certify the provider. Do not bypass its restrictions. The API layer queues work and does not contact Grabfy itself; enablement belongs to the executing bot/worker.

Use a dedicated, least-privilege operator account for permitted public content requiring a source session. End users must not supply their passwords or cookies. Keep exports outside the repository, restrict access, mount originals read-only where supported, and use private per-attempt copies where the adapter provides them. The standalone bot's gallery-dl adapter can receive the configured cookie path directly, so do not assume every adapter makes a copy. Treat browser-profile extraction as access to the operator's browser secrets.

Never log or commit credentials. Rotate/revoke a Discord token, API key, session, or cookie export immediately after exposure; deleting a log or rewriting Git history does not make it safe again. Enable multi-factor authentication on operator accounts where available. Application logout/key revocation does not necessarily invalidate previously signed storage links.

## Storage, cleanup, and retention

Verify source signatures and stream/type checks where supported, aggregate bytes/count limits, cancellation, and cleanup. A failed child transfer must not be reported as successful recovery of a complete album. Selection by output type must not mistake intentionally excluded images for missing videos.

Persistent storage is not a temporary directory. Worker commits use stable create-only identities; never overwrite a previous result or delete an object after an uncertain acknowledgement without establishing ownership. A cancelled or failed queue acknowledgement can leave a committed object. Explicit deletion can remove recovery records, allowing a later delivery to recreate the result. Configure retention for originals, previews, archives, orphaned objects, and recovery metadata.

Keep public and private object buckets distinct, scope storage credentials to the required buckets and operations, and keep credentials out of public delivery. A public object can be copied or cached outside the Service. A signed-link timeout, public cache lifetime, queue-record expiry, or session expiry is not automatic file deletion. PostgreSQL records and presence snapshots need their own retention/deletion process; the current API has no universal scheduled purge or complete self-service account-erasure route.

## API deployment and release checks

Use HTTPS, an HTTPS public origin for Secure browser cookies, a narrow CORS allowlist, correctly scoped trusted reverse proxies, private database/Redis connectivity, independent signing secrets, and least-privilege storage credentials. Review anonymous mode carefully: its access subject is based on server-observed IP and does not isolate people behind a shared address like an account would.

Keep operational logs restricted and redacted, with configured rotation/retention. Request-header redaction does not prove every downloader or exception message is safe. Do not publish raw worker stdout, signed media URLs, or diagnostics containing credentials.

Run the repository's deterministic checks after changes. Default tests use local fixtures/mocks; live source, Redis/database, and object-storage tests remain opt-in and should use disposable infrastructure. Do not run migrations against production merely to validate a patch. A passing unit suite or source review does not certify deployed firewall rules, storage lifecycle, source permissions, or every security property.

The bot's gallery-dl installer accepts platform assets only when the release API publishes a matching SHA-256 digest. Keep downloaded tools in ignored `.tools` directories and out of release source/Docker contexts unless the build explicitly installs them.

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for data handling and deletion requests, and [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) for permitted use and operator responsibilities.

## CI/CD deployment boundary

Pull requests must not receive production credentials. Production deployments accept only validated GitHub Actions OIDC identities from the configured repository, workflow and main branch. Images are deployed by immutable digest; failed readiness checks restore the previous image. Deployment state, registry credentials, backups and runtime configuration remain private on the deployment host. Database backups do not make schema downgrades automatic.

## Contact addresses

- Technical support and privacy/rights requests: [support@mediafilez.online](mailto:support@mediafilez.online).
- Partnerships: [partner@mediafilez.online](mailto:partner@mediafilez.online).
- Vulnerabilities and security incidents: [security@mediafilez.online](mailto:security@mediafilez.online).
