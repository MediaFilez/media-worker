import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable package version is required");
const tag = `v${version}`;
const notes = `releases/${tag}.md`;
if (!readFileSync(notes, "utf8").trim()) throw new Error("Release notes are required");

if (process.argv[2] === "validate") {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    process.exit(0);
}

const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
const headers = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" };
const existing = await fetch(`${base}/releases/tags/${tag}`, { headers, signal: AbortSignal.timeout(15000) });
if (existing.ok) {
    console.log(`${tag} already published; release and image tag remain unchanged.`);
    process.exit(0);
}
if (existing.status !== 404) throw new Error(`Release lookup failed (${existing.status})`);

const image = process.env.IMAGE_REPOSITORY;
const digest = process.env.IMAGE_DIGEST;
if (!/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/.test(image) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid release image");
execFileSync("docker", ["buildx", "imagetools", "create", "--tag", `${image}:${tag}`, `${image}@${digest}`], { stdio: "inherit" });
const response = await fetch(`${base}/releases`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
        tag_name: tag,
        target_commitish: process.env.GITHUB_SHA,
        name: tag,
        body: readFileSync(notes, "utf8"),
        draft: false,
        prerelease: false,
    }),
    signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Release creation failed (${response.status})`);
console.log(`Published ${tag} after production health checks.`);
