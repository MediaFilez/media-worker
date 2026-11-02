import process from "node:process";

const { DEPLOY_URL, DEPLOY_ROLE, IMAGE_DIGEST, GITHUB_SHA, GITHUB_ACTOR, GITHUB_TOKEN } = process.env;
const base = new URL(DEPLOY_URL);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid deploy URL");
const payload = { role: DEPLOY_ROLE, digest: IMAGE_DIGEST, commit: GITHUB_SHA };
const audience = `urn:mediafilez:deploy:${DEPLOY_ROLE}:${IMAGE_DIGEST}:${GITHUB_SHA}`;

async function call(operation, registry = false) {
    const identityUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    identityUrl.searchParams.set("audience", audience);
    const identity = await fetch(identityUrl, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
    });
    if (!identity.ok) throw new Error("GitHub identity unavailable");
    const { value } = await identity.json();
    const response = await fetch(new URL(operation, `${base.href.replace(/\/$/, "")}/`), {
        method: "POST",
        headers: { authorization: `Bearer ${value}`, "content-type": "application/json" },
        body: JSON.stringify({ ...payload, ...(registry ? { registryUser: GITHUB_ACTOR, registryToken: GITHUB_TOKEN } : {}) }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
    });
    if (!response.ok) throw new Error(`Deployment endpoint returned ${response.status}`);
    return response.json();
}

await call("start", true);
for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { state } = await call("status");
    if (state === "healthy") {
        console.log("Deployment passed health checks.");
        process.exit(0);
    }
    if (state === "failed" || state === "unknown") throw new Error("Deployment failed; inspect private server logs.");
}
throw new Error("Deployment timed out; verify server state before retrying.");
