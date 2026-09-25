import fs from "node:fs/promises";
import path from "node:path";

const forbidden = [
    { pattern: /(?:from\s+|require\()["']discord\.js["']/, label: "discord.js dependency" },
    { pattern: /(?:from\s+|require\()["']fastify["']/, label: "Fastify dependency" },
    { pattern: /Discord interaction|Discord attachment/i, label: "Discord delivery concept" },
];

async function sourceFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
        else if (/\.[cm]?[jt]s$/.test(entry.name)) files.push(target);
    }
    return files;
}

const violations = [];
for (const file of await sourceFiles(path.resolve("src"))) {
    const contents = await fs.readFile(file, "utf8");
    for (const rule of forbidden) {
        if (rule.pattern.test(contents)) violations.push(`${path.relative(process.cwd(), file)}: ${rule.label}`);
    }
}

if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write("Worker/Core boundaries are clean.\n");
}
