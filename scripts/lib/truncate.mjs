/**
 * Head+tail byte truncation for large textual payloads (e.g. resolved
 * `git diff` output) inlined into prompt context.
 *
 * Why head+tail and not head-only: a diff cropped at the head silently
 * hides every late hunk (often the meatier last-touched files). Reviewers
 * lose visibility into changes they were specifically asked to assess.
 * Head+tail keeps both ends so the model sees the full file boundary set
 * even when the middle is omitted.
 *
 * Hunk counting: when the input parses cleanly as a unified diff, the
 * separator advertises the exact number of `@@ … @@` hunks dropped. When
 * it doesn't (binary trailers, mid-line cut, partial reads), the helper
 * falls back to the generic `[diff truncated]` marker so we never lie
 * about a count.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });
const HUNK_HEADER = /^@@ /gm;

/**
 * Count `@@ … @@` hunk headers in a textual diff.
 *
 * Cheap and resync-friendly: counts top-level matches via a single regex.
 * Not a parser — it does not distinguish between real hunk headers and
 * lines that happen to start with `@@ ` (which are vanishingly rare in
 * unified diff output).
 *
 * @param {string} text
 * @returns {number}
 */
export function countHunks(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const m = text.match(HUNK_HEADER);
  return m ? m.length : 0;
}

/**
 * Truncate `text` to roughly `maxBytes` bytes (UTF-8 byte-budget) keeping
 * `headBytes` from the start and the remainder from the tail, separated by
 * a marker line.
 *
 * Defaults: 100KB head, 100KB tail (≈ 200KB total) — sized so a typical
 * 20-file PR fits without truncation, and a 1MB churn-fest still inlines
 * the head+tail rather than getting silently dropped.
 *
 * Behavior:
 *  - input under `maxBytes` returns verbatim (no marker)
 *  - empty / nullish input returns `''`
 *  - cuts on UTF-8 byte boundaries safely (multi-byte sequences are
 *    preserved by re-encoding from the same byte offsets and letting
 *    `TextDecoder` drop any partial trailing sequence)
 *
 * Marker text:
 *  - hunk count when computable: `… [<N> hunks omitted] …`
 *  - otherwise: `… [diff truncated] …`
 *
 * @param {string | null | undefined} text
 * @param {{ headBytes?: number, tailBytes?: number }} [opts]
 * @returns {string}
 */
export function truncateHeadTail(text, opts) {
  if (!text) return '';
  const headBytes = opts?.headBytes ?? 100 * 1024;
  const tailBytes = opts?.tailBytes ?? 100 * 1024;
  const maxBytes = headBytes + tailBytes;

  const bytes = ENCODER.encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  const head = DECODER.decode(bytes.subarray(0, headBytes));
  const tail = DECODER.decode(bytes.subarray(bytes.byteLength - tailBytes));

  // Recount hunks on the original payload (cheap; one regex). Subtract the
  // count visible in head + tail so the marker advertises only what was
  // genuinely dropped. If the count math doesn't make sense (negative or
  // zero), fall back to the generic marker.
  const totalHunks = countHunks(text);
  const visibleHunks = countHunks(head) + countHunks(tail);
  const omittedHunks = totalHunks - visibleHunks;
  const marker = omittedHunks > 0 ? `\n… [${omittedHunks} hunks omitted] …\n` : '\n… [diff truncated] …\n';

  return `${head}${marker}${tail}`;
}
