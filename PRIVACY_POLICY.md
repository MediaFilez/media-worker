# MediaFilez Privacy Policy

**Effective date:** November 2, 2026

**Last updated:** November 2, 2026

This Policy describes the official hosted MediaFilez services operated by the MediaFilez project (the "Operator", "we", "us", or "our"). It covers the Discord application and, where deployed, the website/account API and background media workers. The interfaces you use determine which processing below applies. Independent hosts must provide their own accurate notices; this Policy does not describe their deployments.

## 1. Requests and source access

MediaFilez receives public source URLs and requested output options, retrieves and validates supported media, may convert or compress it, and delivers attachments or stored files. Posts can produce multiple files. Saved playlists store links and metadata; downloading a playlist creates separate processing jobs.

An operator may configure dedicated source-platform cookies or an operator-controlled browser profile for permitted public content that requires a signed-in visitor. End users do not sign into source platforms through MediaFilez and must not submit source-platform passwords, cookies, or private session exports. Discord OAuth for a MediaFilez website account is separate from source-platform access.

## 2. Information processed

### Discord application

The standalone bot receives the Discord user ID, username or display tag, command and selected options, interaction identifiers, server/channel context provided by Discord, permissions, and attachment-size limits. It processes source URLs, files, filenames, file sizes/types, and source metadata such as title, creator, duration, dimensions, thumbnail URL, or source item ID when available.

The bot uses the Guilds intent. It does not request the Message Content privileged intent or read ordinary chat messages. Its active-job accounting is held in memory; it does not itself provide the API's persistent account database. Logs can include Discord tags, command context, engine names, filenames, sizes, timings, errors, and diagnostic messages. They are not anonymous by definition.

### Website and API accounts

The API uses PostgreSQL for account and service records. Depending on the configured login methods, this includes email and password hashes, Discord user ID/username/avatar, account role and timestamps, session token hashes and expiry, and API-key hashes plus names, prefixes, expiry and usage metadata. Raw newly issued API keys are returned to the authorized client; the API stores hashes rather than those raw keys.

Discord login uses the `identify` permission and a temporary authorization-code exchange with PKCE. The exchanged Discord OAuth access token is used to obtain identity; the account implementation does not persist it as an account credential. Browser authentication uses an HttpOnly session cookie. Its Secure flag depends on an HTTPS public origin, which operators must configure for production. Supported legacy email/password accounts have their own authentication flow.

The website stores the chosen theme in localStorage and keeps entered links, pending job IDs, ZIP progress and a local login-return path in sessionStorage. These are browser-side records, not a promise of deletion from backend storage. The browser can fetch signed media and assemble ZIP files locally. The website server reads public bot totals or, with its private reader credential, selected community metadata.

PostgreSQL also stores submitted URLs/options, job ownership, payloads, status, results, errors, idempotency information, timestamps, batch records, file metadata and object keys, visibility/expiry fields, content records, and saved playlists/items. These records can include personal data contained in a URL, filename, caption, creator name, or submitted title.

The API processes the server-observed IP address for request limits and, where anonymous downloads are enabled, an anonymous job-access subject. People sharing an observed IP can share that anonymous subject; anonymous mode does not provide account-level separation.

### Workers, storage, and queues

Redis/BullMQ carries job URLs/options, progress, results, cancellation/control information, and queue metadata. Workers process source files, previews, archives, extractor metadata, and isolated working directories. The storage adapter writes outputs and associated recovery metadata to the configured local root or object-storage bucket. Persistent storage is separate from temporary job cleanup. Local-storage durability across container replacement requires an operator-managed persistent volume; the shipped worker Compose configuration does not mount one for stored media.

### Optional official Discord presence reporting

The separate official presence reporter can send application/bot identity, instance identity and liveness heartbeats, guild IDs, guild names, icons, features, approximate member counts, and vanity codes. The API stores the latest snapshot in Redis. The public summary exposes aggregate status/counts; detailed snapshots require dedicated control credentials. If the operator enables a public community directory, selected guild metadata can also be published by the website backend. Reporting does not collect ordinary messages or member lists. The standalone bot does not automatically enable this separate reporter.

### Logs and service integrations

Operational records may include request IDs, request paths, timestamps, account/job IDs, Discord tags, source/engine errors, filenames, sizes, and processing times. Authentication headers, cookies, tokens, private keys, and signed media URLs must not be intentionally placed in operational logs. Extractor diagnostics or exception messages can still contain URLs or filenames; operators must restrict access, redact sensitive values, and configure log retention. This is not a guarantee that every third-party diagnostic is automatically scrubbed.

The reviewed applications do not include advertising or behavioral-analytics SDKs. Deployment providers and source websites can independently process their own traffic and logs.

## 3. Purposes and legal basis

We process information to authenticate authorized clients, validate and execute requests, enforce limits, deliver files, retain requested account/playlist/job features, recover interrupted storage commits, communicate progress, investigate faults or abuse, protect rights and security, and meet legal obligations.

Where a legal basis is required, the appropriate basis depends on the processing and applicable law, including providing the requested service, legitimate interests subject to required balancing, legal obligations, or consent when specifically required. This Policy does not replace consent where the law requires it.

## 4. Recipients and visibility

Information can be disclosed to:

- **Discord:** interactions and delivered replies/attachments. Source metadata can be processed without being included in every reply. Discord handles its copies under its own [Privacy Policy](https://discord.com/privacy).
- **Source platforms and their CDNs:** the requested source/media URL, the Service's server IP, and request headers. An operator session can associate source activity with that operator account.
- **Configured relays and Cobalt instances:** relevant source URLs and media options. Instagram embed proxies are configurable; `INSTAGRAM_PROXY_HOSTS=none` disables them. Reddit relays are configurable through `REDDIT_PROXY_HOSTS`, including `none`. Defaults differ between the bot and worker distributions; consult that deployment's configuration. Reddit processing can also contact `embed.reddit.com`. Cobalt directory discovery is opt-in; a configured external instance has independent practices. Local yt-dlp, gallery-dl, YouTube.js, FFmpeg, and FFprobe process only the stages in which they are used.
- **Hosting, PostgreSQL/Redis, storage, networking, and logging providers:** the data needed for the configured infrastructure. Public object storage/CDN delivery can expose originals, previews, and filenames to anyone with access to the public location.
- **Authorized administrators and required recipients:** limited information for operation, support, rights complaints, legal requirements, and protection against abuse.

We do not sell or rent personal information or use it for targeted advertising. Adding a new external processing service requires reviewing its terms/privacy practices, allowing the operator to disable or configure it, and updating the deployment's disclosures as needed. A successful technical test is not approval of a provider's legal or privacy practices.

Discord guild replies are normally visible to the invoking channel unless the private option or deployment settings make them ephemeral. A private Discord reply does not make source access private. Public playlist/file options and forwarded links can expose material outside your account. A signed private storage link is usable by a recipient until its expiry, subject to provider controls; account logout or key revocation does not necessarily invalidate links already issued.

### Optional Grabfy processing

`GRABFY_ENABLED` is false by default. If the operator enables it in the bot or worker, MediaFilez sends a canonical public Instagram post/Reel URL, the server IP, and ordinary request headers to `api.grabfy.com`. Source query parameters/fragments are removed. The adapter does not forward Discord identities, application API keys, authorization headers, or source-platform cookies. Media downloads can also pass through Grabfy's signed proxy URLs. These URLs are sensitive download capabilities and must not be logged.

Grabfy's published [privacy notice](https://grabfy.com/privacy-policy/) allows technical/usage information, analytics technologies, other service providers, and retention for operational/security/legal purposes without a fixed deletion period. MediaFilez has not independently verified its internal processing, upstream providers, storage, or deletion practices. Its homepage's no-tracking claims are not a MediaFilez guarantee. The server API request does not execute Grabfy's webpage scripts, but this does not prevent server-side logging. Disabling `GRABFY_ENABLED` prevents this adapter from sending further requests; it cannot erase information already received by Grabfy.

## 5. Retention and deletion

These retention mechanisms are separate:

- **Bot active jobs:** in-memory user accounting lasts while requests are queued/running and is removed afterward.
- **Temporary job files:** cleanup is attempted after success, failure, or cancellation. A crash can leave working files or staging directories. Recovery removes abandoned directories only when ownership checks permit it; another host's or uncertain owner's files may need operator cleanup.
- **Redis queue records:** completion/failure retention uses configured age/count limits; the API's default completion/failure age is 24 hours. That setting does not erase PostgreSQL history or stored media. Cancellation/control keys and presence snapshots have separate lifetimes; the latest presence snapshot does not have an automatic TTL in the current implementation.
- **Accounts, playlists, jobs, and other PostgreSQL records:** persist until deleted by an authorized process or the operator's applicable retention/deletion procedure. The repository does not implement a universal scheduled purge or a complete self-service account-erasure endpoint.
- **Stored originals, previews, archives, and recovery metadata:** remain until explicitly deleted or removed by a configured storage lifecycle/retention process. A worker's temporary cleanup does not automatically delete these outputs. Private access expiry, session expiry, public cache lifetime, and signed-link expiry are not media-erasure schedules.
- **Discord, public, downloaded, or forwarded copies:** have lifetimes controlled by Discord, recipients, caches, and their respective policies. Deleting a local job cannot recall them.
- **Operational logs and backups:** use the deployment's restricted-access retention, rotation, legal-hold, and backup-expiry procedures. The bot's default Compose logging rotates by size, so elapsed retention varies with activity. Other deployments must configure their own limits.

Operators must define retention periods and deletion procedures for their actual deployment before public operation. We retain information only as needed for the stated purposes or legal obligations; no automatic deletion period is promised where the implementation does not provide one. Provider-level backups and logs can take additional time to expire.

## 6. Security measures and their limits

Controls include authentication and ownership checks for protected API resources, credential hashing, configured request/job limits, URL/DNS/redirect checks in guarded HTTP adapters, bounded transfers, filename handling, isolated temporary job paths, cancellation/time limits, and argument-array subprocess invocation.

These are application controls, not a complete operating-system sandbox. Native extractors and libraries have different network behavior between distributions. Untrusted production workloads require OS-enforced egress restrictions, least-privilege tool identities, resource limits, and private infrastructure access. The worker's proxy does not itself prevent an extractor from bypassing it without deployment enforcement. Filesystem access remains part of a native process's authority. The code does not promise antivirus scanning, content-rights verification, or absolute security. See [SECURITY.md](SECURITY.md).

## 7. Your choices and rights

Where applicable, you may have rights to access, correction, deletion, restriction, portability, objection, withdrawal of consent, and a complaint or appeal to a competent authority. Mandatory rights are not waived by using the Service.

Email **support@mediafilez.online** with the subject **"MediaFilez Privacy Request"**. Include your MediaFilez account or Discord user ID, approximate request time, relevant file/job IDs if known, and what you request. Do not send passwords, session cookies, bot tokens, or private media. We may request reasonable identity verification and retain information required by law or a valid security/legal need.

The standalone bot may lack enough persistent identifiers to locate a past request. API records may be identifiable by account/job ownership. Some actions require manual operator work; there is no promise of a self-service erasure feature. Discord messages and independently hosted provider copies may require action with the respective provider. Credential revocation limits future authentication but does not erase stored records or third-party copies by itself.

## 8. Children and international processing

The Service is not directed to children under 13 or people below the applicable platform minimum age. Contact us if you believe a child supplied information contrary to these requirements.

Providers can process data in countries other than your own. The Operator must establish any transfer safeguards required by applicable law; this software distribution does not itself establish a transfer agreement, provider contract, or legal basis for every deployment.

## 9. Changes and contact

Changes are published at the same location with an updated date. Material changes require appropriate notice or consent where applicable law requires it.

**MediaFilez Project**

Email: **support@mediafilez.online**

Before launching a deployment, its operator must publish the responsible entity/contact, actual providers, applicable retention periods, and other legally required particulars. Independently hosted services must replace this notice with one that describes their own processing. This Policy describes the reviewed operating model and does not certify legal compliance in every jurisdiction.

## Contact addresses

- Technical support and privacy/rights requests: [support@mediafilez.online](mailto:support@mediafilez.online).
- Partnerships: [partner@mediafilez.online](mailto:partner@mediafilez.online).
- Vulnerabilities and security incidents: [security@mediafilez.online](mailto:security@mediafilez.online).
