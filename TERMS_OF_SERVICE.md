# MediaFilez Terms of Service

**Effective date:** November 2, 2026

**Last updated:** November 2, 2026

These Terms govern the official hosted MediaFilez services operated by the MediaFilez project (the "Operator", "we", "us", or "our"). Depending on the deployment, the services include the Discord application, website and account API, and background workers that retrieve, process, and store media. Using an interface does not mean every other interface or feature is available to you.

The source code is separately licensed under AGPL-3.0-only. These Terms do not restrict rights granted by that license. Independently hosted copies have their own operators, terms, privacy notices, and security responsibilities.

## 1. Eligibility and accounts

You must be at least 13, meet the minimum age for Discord and any other platform you use, and be legally permitted to use the Service. A parent or guardian must agree where applicable law requires it.

Keep your account sessions and API keys private. You are responsible for authorized activity under your account and for promptly reporting suspected compromise. Do not share another person's credentials or impersonate another person. Access limits apply to the account across supported authentication methods; anonymous access, where enabled, may be grouped by the server-observed IP address.

## 2. What the Service provides

MediaFilez accepts supported public HTTP or HTTPS source URLs. It attempts to retrieve media, validate supported file types, optionally convert or compress them, and deliver the result through the requested interface. A post can produce multiple images, videos, attachments, files, or Discord replies. Collections, batches, and archives have configured count, size, time, and delivery limits. An extractor may expose only part of a source; a successful request is not a guarantee that every source item was discoverable.

The API may store accounts, saved playlist links, job history, file metadata, and processed media. Workers may store originals, previews, and archives in configured local or object storage. The standalone Discord application uses temporary working files and sends attachments to Discord. A playlist entry saves a link and its metadata; a separate download request can create stored files.

Availability, supported sites, extractors, quality, ordering, filenames, and limits can change. A selected quality is a preference where source variants exist, not a guarantee of a particular resolution. The Service is not a backup or permanent archive. Keep your own lawful copies of anything you need to retain.

Delivery can fail after some results were uploaded or stored. Cancellation or an error does not guarantee that no files or Discord messages exist. Check the job and destination before repeating a request. Retries and explicit deletion can interact with storage recovery; deleting a file does not prevent a later authorized request from recreating it.

## 3. Source access and third parties

The Service may contact source platforms, content-delivery networks, operator-configured embed relays, and Cobalt instances. These services have their own rules and privacy practices, can refuse access, and may become unavailable. Public Cobalt discovery is opt-in; an operator must have permission to use any independently operated instance. The Service does not promise to work around a source's rejection or restrictions.

An operator may configure a dedicated source-platform account, exported cookies, or an operator-controlled browser profile for public media that requires a signed-in visitor. End users must not send source-platform passwords, cookies, or session exports. A session does not grant permission to retrieve private, paid, removed, rights-restricted, or otherwise protected content. Network validation does not determine the copyright or access status of a post.

Grabfy is an optional external Instagram resolver, disabled by default. Enabling it sends a canonical public post/Reel URL to Grabfy and can route media through its proxy. The operator must review [Grabfy's terms](https://grabfy.com/terms-of-service/) and [privacy notice](https://grabfy.com/privacy-policy/), establish permission for the intended API/bot use, and respect access restrictions and limits. Published website access is not a documented API license or permission for commercial use.

MediaFilez is independent of Discord, Meta, source platforms, and third-party download services unless a separate express statement says otherwise.

## 4. Your responsibilities and prohibited use

For each request, you represent that you have the rights, permissions, or other lawful basis needed to access, download, process, store, and share the requested material. You must comply with applicable law, the source platform's rules, technical restrictions, and the rules of the destination, including the [Discord Terms](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines) when using Discord.

You must not:

- access private accounts, paywalls, removed material, DRM-protected content, or other protected resources without authorization;
- bypass authentication, authorization, rate limits, platform safeguards, or other access controls;
- infringe copyright, privacy, publicity, contractual, or other rights;
- submit credentials, access tokens, private signed links, secrets, or personal data you are not entitled to disclose to the services processing your request;
- obtain, store, or distribute child sexual abuse material, non-consensual intimate material, exploitative content, malware, or other unlawful material;
- harass, threaten, dox, impersonate, defraud, or invade another person's privacy;
- overload or disrupt the Service, probe systems without authorization, evade account limits, or use abusive automated request volumes; or
- use a public delivery option or Discord destination to expose material you are not entitled to publish.

Technical accessibility is not permission to copy or redistribute content. The Service does not grant rights to third-party media and does not independently verify every rights claim or source restriction. This does not excuse misuse by an operator or user.

Good-faith security reports must follow [SECURITY.md](SECURITY.md). Do not conduct destructive tests or use other people's data to demonstrate a problem.

## 5. Processing permission and visibility

You keep any rights you have in submitted material. You grant the Operator a limited, non-exclusive permission to retrieve, copy, temporarily or persistently store as described in the Privacy Policy, validate, transform, and transmit the submitted URL, media, and associated metadata only to provide, secure, troubleshoot, and legally operate the Service. This permission ends when that processing is no longer needed, subject to provider retention, legal obligations, and copies outside our control.

Review the destination and visibility before requesting delivery. Discord replies can be public in the invoking channel; the private reply option concerns Discord message visibility, not the source's access permissions. Public files and public playlists may be accessible to others. Anyone receiving a signed private download URL may use it until it expires, subject to the delivery provider's controls. Revoking an account credential does not necessarily revoke a previously issued storage link or a copy already downloaded.

## 6. Privacy, retention, and deletion

The [Privacy Policy](PRIVACY_POLICY.md) explains processing by interface, disclosures, retention limits, and how to request deletion. Temporary job cleanup, queue expiry, signed-link expiry, and deletion of stored files are different operations. The Service does not promise that expiring a link automatically erases its media or database records.

You control deletion of Discord messages and attachments only to the extent Discord permits. Public or forwarded copies, source-platform copies, and independently operated providers are outside the Operator's direct control.

## 7. Restrictions and termination

We may reject requests or limit, suspend, or terminate access when reasonably necessary to prevent abuse, protect the Service or others, address a rights complaint, comply with law or platform rules, investigate a security issue, or enforce these Terms. We may discontinue a feature or the Service. Where required by law, applicable notice, explanation, and challenge rights remain available.

For a mistaken restriction, contact us with the relevant account or Discord user ID and a concise description. Do not send credentials or private media.

## 8. Rights complaints

Email **mediafilez44@gmail.com** with the subject **"MediaFilez Rights Report"**. Include the source URL, affected file or Discord location if known, your relationship to the work or person, the basis of the complaint, and contact details for a response. Do not include unnecessary personal information. We may seek reasonable verification and restrict access while reviewing a complaint. Discord-hosted attachments may also require a report through Discord.

## 9. Availability and warranties

To the extent permitted by applicable law, the Service is supplied "as available", without warranties of uninterrupted operation, compatibility, accuracy, permanent storage, non-infringement, or fitness for a particular purpose. Third-party content and services are outside our control. We do not warrant that a user's requested download, storage, or redistribution is lawful.

These limits do not exclude mandatory consumer guarantees or other rights that cannot lawfully be excluded.

## 10. Liability and responsibility for misuse

To the extent permitted by applicable law, the Operator and project contributors are not liable for indirect or consequential loss, lost profits, lost data, or loss caused by third-party outages, source restrictions, or a user's unauthorized use. Where a contractual cap is permitted, aggregate liability for the Service is limited to the greater of amounts you paid for it in the six months preceding the claim or USD 10.

You remain responsible for harm caused by your unlawful submissions or use. Any recovery of costs or damages remains subject to applicable law and the responsibility of the parties involved. These Terms do not transfer the Operator's own legal obligations to users.

Nothing excludes liability or remedies that applicable law does not allow us to exclude, including any applicable rules concerning fraud, intentional misconduct, gross negligence, personal injury, or statutory consumer and data-protection rights. These Terms are not a guarantee of immunity from claims or regulatory action.

## 11. Changes and disputes

We may revise these Terms when the Service or its legal or operational requirements change. Revisions will be published at the same location with an updated effective date. Material changes require appropriate notice or acceptance where applicable law requires it; continued use is not a substitute for legally required consent.

Applicable law and any mandatory jurisdiction rules govern disputes. Contact us first so we can try to resolve a complaint; this does not delay urgent relief or restrict mandatory rights. If a term is unenforceable, the remaining terms continue to the extent permitted by law. These Terms and the Privacy Policy govern the official Service, subject to the software license and applicable third-party rules.

## 12. Contact and deployment responsibility

**MediaFilez Project**

Email: **mediafilez44@gmail.com**

Repositories: [Bot](https://github.com/RlxChap2/MediaFilez), plus the API and worker distributions used by the deployment.

These documents describe the software's supported operating model. Before a public or commercial deployment, the Operator must identify the responsible legal entity and contact details, confirm applicable jurisdictions and source/provider permissions, set retention and deletion procedures, and obtain legal review appropriate to that deployment. Independently hosted services must publish notices that describe their own operation.
