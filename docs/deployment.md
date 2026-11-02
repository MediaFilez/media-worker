# Releases and deployment

Pull requests run tests and container builds. After a reviewed merge to `main`, CI publishes a commit image to GHCR, deploys its immutable digest, waits for health checks, and publishes the package version as a GitHub Release. Existing release tags remain unchanged. Increment `package.json` and add `releases/v<version>.md` for the next release.

Set the repository Actions secret `DEPLOY_URL` to the provisioned HTTPS deployment gateway. The gateway validates a short-lived GitHub OIDC identity against the repository ID, main branch, workflow path and exact commit. Pull requests cannot deploy. No server login key, production environment file, cookie or database credential is stored in the repository or Actions secrets. Private GHCR packages must inherit repository access for the workflow token to pull them.

The host serializes deployment, checks image revision/source labels, and saves the previous runtime configuration. Failed readiness restores the previous image. API and worker updates drain active queue jobs and preserve its previous pause state. API updates take a private database backup before migrations. Rollback does not downgrade the database; schema changes must stay compatible with the previous application until a separate reviewed migration removes old fields.

Production runtime files, deployment role mappings, backups and receipts stay on the host. Diagnose failures there without copying credentials or signed media links into Actions logs or public issues. Health checks cover service readiness; run an end-to-end download check when changing an engine or storage configuration.
