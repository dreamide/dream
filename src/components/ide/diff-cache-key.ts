import type { FileDiffMetadata } from "@pierre/diffs";

// cyrb53: a fast, well-distributed 53-bit string hash.
const cyrb53 = (value: string, seed: number) => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

/**
 * Give a parsed diff a content-derived `cacheKey`.
 *
 * Pierre's worker pool only caches (and can only pre-highlight) diffs that
 * have one, and our patches are parsed without a key prefix. Deriving it from
 * the content means an identical diff opened again reuses its highlighting.
 */
export const withDiffCacheKey = (
  fileDiff: FileDiffMetadata,
): FileDiffMetadata => {
  if (fileDiff.cacheKey != null) return fileDiff;
  const content = JSON.stringify([
    fileDiff.prevName,
    fileDiff.name,
    fileDiff.lang,
    fileDiff.hunks,
    fileDiff.deletionLines,
    fileDiff.additionLines,
  ]);
  // Two seeds give ~106 bits, so unrelated diffs effectively never share a key.
  const hash = `${cyrb53(content, 0).toString(36)}${cyrb53(content, 1).toString(36)}`;
  return { ...fileDiff, cacheKey: `dream-diff:${content.length}:${hash}` };
};
