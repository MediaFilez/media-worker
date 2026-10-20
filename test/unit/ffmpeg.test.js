import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processMedia } from "../../src/media-core/media/processor.js";
import { checkFFmpeg, compressImage, extractThumbnail, getMediaInfo, runFFmpeg } from "../../src/media-core/utils/ffmpeg.js";
import { withJobResources, jobResources } from "../../src/media-core/utils/resources.js";
import { validateArtifact } from "../../src/media-core/download/artifact.js";

test("original audio extraction preserves encoded AAC packets and sample rate", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-original-audio-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.mp4");
    await runFFmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=s=64x64:d=0.4",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.4:sample_rate=48000",
        "-shortest",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        "-y",
        input,
    ]);
    const artifact = await validateArtifact(input, { outputType: "video" });
    const output = await processMedia(artifact, { outputType: "audio", format: "original", tempDir: dir });
    const info = await getMediaInfo(output.filePath);
    assert.equal(info.hasVideo, false);
    assert.equal(info.audioCodec, "aac");
    assert.equal(info.audioSampleRate, 48000);
    const packets = async (file) =>
        (await runFFmpeg(["-i", file, "-map", "0:a:0", "-c:a", "copy", "-f", "hash", "-hash", "sha256", "-"])).stdout.trim();
    assert.equal(await packets(output.filePath), await packets(input));
    assert.match(output.note, /without re-encoding/);
});

test("requested MP3 passes through an already validated MP3 without transcoding", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-mp3-copy-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.mp3");
    await runFFmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "libmp3lame", "-y", input]);
    const artifact = await validateArtifact(input, { outputType: "audio" });
    const bytes = await fs.readFile(input);
    const output = await processMedia(artifact, { outputType: "audio", format: "mp3", tempDir: dir });
    assert.equal(output.filePath, input);
    assert.deepEqual(await fs.readFile(output.filePath), bytes);
    assert.deepEqual(await fs.readdir(dir), ["source.mp3"]);
});

test("job-scoped FFprobe cache reuses unchanged files and invalidates replacements", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-probe-cache-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.wav");
    await runFFmpeg(["-f", "lavfi", "-i", "sine=duration=0.2", "-y", input]);
    await withJobResources(dir, new AbortController().signal, async (signal) => {
        const first = await getMediaInfo(input, { signal });
        assert.equal(await getMediaInfo(input, { signal }), first);
        assert.equal(jobResources().mediaInfoCache.size, 1);
        await runFFmpeg(["-f", "lavfi", "-i", "sine=duration=0.4", "-y", input], { signal });
        const replaced = await getMediaInfo(input, { signal });
        assert.notEqual(replaced, first);
        assert.ok(replaced.duration > first.duration);
        assert.equal(jobResources().mediaInfoCache.size, 2);
    });
});

test("converts audio to requested MP3 without requiring size compression", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-mp3-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.wav");
    await runFFmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "pcm_s16le", "-y", input]);
    const value = {
        filePath: input,
        fileName: "source.wav",
        sizeBytes: (await fs.stat(input)).size,
        mediaKind: "audio",
        extension: "wav",
        isAudioOnly: true,
    };
    for (const maxOutputBytes of [undefined, 100_000]) {
        const output = await processMedia(value, { outputType: "audio", format: "mp3", tempDir: dir, maxOutputBytes, allowCompression: false });
        assert.equal(output.extension, "mp3");
        assert.match(output.note, /converted to MP3/);
        assert.equal((await getMediaInfo(output.filePath)).hasAudio, true);
    }
    await assert.rejects(
        processMedia(value, { outputType: "audio", format: "mp3", tempDir: dir, maxOutputBytes: 1, allowCompression: false }),
        (error) => error.code === "FILE_TOO_LARGE",
    );
});

test("extracts an image from a sub-second video", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-short-video-"));
    const input = path.join(dir, "short.mp4");
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await runFFmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.2", "-c:v", "libx264", "-y", input]);

    const output = await extractThumbnail(input, dir);
    assert.ok((await fs.stat(output)).size > 0);
});

test("auto fits low-bitrate video and reports transcoding progress", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-fit-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.mp4");
    await runFFmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=24:duration=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=12",
        "-shortest",
        "-c:v",
        "libx264",
        "-b:v",
        "500k",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-y",
        input,
    ]);

    const targetSize = 220 * 1024;
    const statuses = [];
    const output = await processMedia(
        {
            filePath: input,
            fileName: "source.mp4",
            sizeBytes: (await fs.stat(input)).size,
            mediaKind: "video",
            extension: "mp4",
        },
        {
            outputType: "auto",
            tempDir: dir,
            maxOutputBytes: targetSize,
            allowCompression: true,
            onStatus: (status) => statuses.push(status),
        },
    );

    assert.ok(output.sizeBytes <= targetSize);
    assert.equal((await getMediaInfo(output.filePath)).hasAudio, true);
    assert.ok(
        statuses.some((status) => status.phase === "processing" && Number.isFinite(status.progress?.percent)),
        "expected at least one processing progress update",
    );
    assert.ok(
        !statuses.some((status) => /lossless|audio-only/i.test(status.detail || "")),
        "expected mathematically impossible fast-fit attempts to be skipped",
    );
});

test("auto fits oversized audio instead of rejecting the original", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-audio-fit-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.wav");
    await runFFmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "pcm_s16le", "-y", input]);

    const targetSize = 80 * 1024;
    const inputSize = (await fs.stat(input)).size;
    assert.ok(inputSize > targetSize);
    const output = await processMedia(
        {
            filePath: input,
            fileName: "source.wav",
            sizeBytes: inputSize,
            mediaKind: "audio",
            extension: "wav",
            isAudioOnly: true,
        },
        {
            outputType: "auto",
            tempDir: dir,
            maxOutputBytes: targetSize,
            allowCompression: true,
        },
    );

    assert.ok(output.sizeBytes <= targetSize);
    assert.equal(output.extension, "mp3");
    assert.match(output.note, /requested size/);
});

test("original audio output preserves Opus from a WebM video", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-webm-audio-"));
    const input = path.join(dir, "source.webm");
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await runFFmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x90:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-shortest",
        "-c:v",
        "libvpx-vp9",
        "-c:a",
        "libopus",
        "-y",
        input,
    ]);
    const inputInfo = await getMediaInfo(input);

    const output = await processMedia(
        {
            filePath: input,
            fileName: "source.webm",
            sizeBytes: (await fs.stat(input)).size,
            mediaKind: "video",
            extension: "webm",
            isAudioOnly: false,
            mediaInfo: inputInfo,
        },
        {
            outputType: "audio",
            tempDir: dir,
            maxOutputBytes: 10 * 1024 * 1024,
            allowCompression: true,
        },
    );

    const outputInfo = await getMediaInfo(output.filePath);
    assert.equal(output.extension, "opus");
    assert.equal(outputInfo.hasVideo, false);
    assert.equal(outputInfo.hasAudio, true);
    assert.equal(outputInfo.audioCodec, inputInfo.audioCodec);
});

test("auto fits oversized images instead of rejecting the original", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-image-fit-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "source.bmp");
    await runFFmpeg(["-f", "lavfi", "-i", "testsrc2=size=1024x1024", "-frames:v", "1", "-y", input]);

    const targetSize = 120 * 1024;
    const inputSize = (await fs.stat(input)).size;
    assert.ok(inputSize > targetSize);
    const output = await processMedia(
        {
            filePath: input,
            fileName: "source.bmp",
            sizeBytes: inputSize,
            mediaKind: "image",
            extension: "bmp",
        },
        {
            outputType: "auto",
            tempDir: dir,
            maxOutputBytes: targetSize,
            allowCompression: true,
        },
    );

    assert.ok(output.sizeBytes <= targetSize);
    assert.equal(output.extension, "jpg");
    assert.match(output.note, /requested size/);
});

test("image fitting rejects unsafe decoded dimensions", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-image-dimensions-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "extreme.png");
    await runFFmpeg(["-f", "lavfi", "-i", "color=c=white:s=2x20000:d=0.04", "-frames:v", "1", "-y", input]);

    await assert.rejects(
        compressImage(input, dir, 10 * 1024 * 1024),
        (error) => error.name === "UserFacingError" && error.code === "IMAGE_DIMENSIONS_TOO_LARGE",
    );
});

test("image fitting caps both output dimensions", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-image-aspect-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, "tall.png");
    await runFFmpeg(["-f", "lavfi", "-i", "color=c=white:s=8x8000:d=0.04", "-frames:v", "1", "-y", input]);

    const output = await compressImage(input, dir, 10 * 1024 * 1024);
    const info = await getMediaInfo(output);

    assert.ok(info.width <= 4096);
    assert.ok(info.height <= 4096);
});
