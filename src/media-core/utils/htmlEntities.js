const NAMED_ENTITIES = new Map([
    ["amp", "&"],
    ["quot", '"'],
    ["apos", "'"],
    ["lt", "<"],
    ["gt", ">"],
]);

export function decodeHtmlEntities(value) {
    return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|quot|apos|lt|gt));/gi, (match, decimal, hex, named) => {
        if (named) return NAMED_ENTITIES.get(named.toLowerCase()) ?? match;
        try {
            return String.fromCodePoint(Number.parseInt(decimal ?? hex, decimal ? 10 : 16));
        } catch {
            return match;
        }
    });
}
