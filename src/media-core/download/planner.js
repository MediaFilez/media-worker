import path from "node:path";
import { config } from "../config.js";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]);
const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "m.reddit.com", "old.reddit.com", "new.reddit.com", "redd.it"]);
const GALLERY_HOSTS = new Set([
    ...INSTAGRAM_HOSTS,
    "pinterest.com",
    "www.pinterest.com",
    "pin.it",
    "flickr.com",
    "www.flickr.com",
    "imgur.com",
    "www.imgur.com",
]);
const COBALT_HOSTS = new Set([
    ...YOUTUBE_HOSTS,
    ...INSTAGRAM_HOSTS,
    ...TIKTOK_HOSTS,
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
    "facebook.com",
    "www.facebook.com",
    "fb.watch",
    "reddit.com",
    "www.reddit.com",
    "redd.it",
    "tumblr.com",
    "www.tumblr.com",
    "bsky.app",
    "soundcloud.com",
    "vimeo.com",
    "www.vimeo.com",
    "snapchat.com",
    "www.snapchat.com",
    "streamable.com",
    "www.streamable.com",
    "vk.com",
    "bilibili.com",
    "www.bilibili.com",
    "b23.tv",
    "dailymotion.com",
    "www.dailymotion.com",
    "dai.ly",
    "loom.com",
    "www.loom.com",
    "newgrounds.com",
    "www.newgrounds.com",
    "ok.ru",
    "www.ok.ru",
    "rutube.ru",
    "www.rutube.ru",
    "twitch.tv",
    "www.twitch.tv",
    "clips.twitch.tv",
]);
const DIRECT_EXTENSIONS = new Set([
    ".mp4",
    ".webm",
    ".mov",
    ".m4v",
    ".mp3",
    ".m4a",
    ".ogg",
    ".opus",
    ".wav",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".avif",
]);

function matchesHost(host, supportedHosts) {
    for (const supportedHost of supportedHosts) {
        if (host === supportedHost || host.endsWith(`.${supportedHost}`)) return true;
    }
    return false;
}

export function classifySource(rawUrl) {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const extension = path.extname(url.pathname).toLowerCase();
    return {
        direct: DIRECT_EXTENSIONS.has(extension),
        youtube: matchesHost(host, YOUTUBE_HOSTS),
        instagram: matchesHost(host, INSTAGRAM_HOSTS),
        reddit: matchesHost(host, REDDIT_HOSTS),
        gallery: matchesHost(host, GALLERY_HOSTS),
        cobalt: matchesHost(host, COBALT_HOSTS),
        host,
    };
}

export function planEngines(rawUrl, outputType, settings = config) {
    const source = classifySource(rawUrl);
    let names;
    if (source.direct) names = ["direct-http"];
    else if (source.youtube) names = ["yt-dlp", "youtube-js", "cobalt", "page-metadata"];
    else if (source.reddit && ["auto", "image", "thumbnail"].includes(outputType)) {
        names = ["reddit-embed", "reddit-proxy", "gallery-dl", "yt-dlp", "cobalt", "page-metadata"];
    } else if (source.reddit) {
        names = ["cobalt", "yt-dlp", "reddit-embed", "reddit-proxy", "gallery-dl", "page-metadata"];
    } else if (source.instagram && settings.instagramProxyFirst && ["auto", "video"].includes(outputType)) {
        names = ["instagram-proxy", "yt-dlp", "cobalt", "gallery-dl", "page-metadata"];
    } else if (source.instagram && ["auto", "image", "thumbnail"].includes(outputType)) {
        names = ["gallery-dl", "yt-dlp", "instagram-proxy", "cobalt", "page-metadata"];
    } else if (source.instagram) {
        names = ["yt-dlp", "instagram-proxy", "cobalt", "gallery-dl", "page-metadata"];
    } else if (source.gallery) names = ["gallery-dl", "yt-dlp", "cobalt", "page-metadata"];
    else if (source.cobalt) names = ["cobalt", "yt-dlp", "gallery-dl", "page-metadata"];
    else names = ["page-metadata", "direct-http"];

    return names.filter((name) => {
        if (settings.disabledEngines?.has(name)) return false;
        if (name === "youtube-js" && !settings.youtubeJsEnabled) return false;
        if (name === "gallery-dl" && !settings.galleryDlEnabled) return false;
        if (name === "page-metadata" && settings.pageMetadataEnabled === false) return false;
        if (name === "instagram-proxy" && settings.instagramProxyHosts?.length === 0) return false;
        if (name === "reddit-proxy" && settings.redditProxyHosts?.length === 0) return false;
        if (name === "cobalt" && settings.cobaltApiEndpoints.length === 0 && !settings.cobaltDirectoryEnabled) {
            return false;
        }
        return true;
    });
}
