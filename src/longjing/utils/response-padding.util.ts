/**
 * Response padding utility for Privacy fix: Response metadata linkability
 *
 * Implements output padding to prevent response size from being used
 * to correlate requests. Pads response content to predefined size buckets.
 *
 * Security benefit:
 * - Prevents correlation of requests by exact response length
 * - Reduces metadata leakage from response body size
 * - Complements timing protection to reduce linkability vectors
 *
 * Note: This padding is applied to the response CONTENT, not the entire HTTP response.
 * The goal is to make the response body fit into discrete size classes to prevent
 * fine-grained size-based fingerprinting.
 */

/**
 * Response size classes in bytes (powers of 2 for efficient padding)
 */
const SIZE_CLASSES = [
  512, // 512B - very small responses
  1024, // 1KB - small responses
  2048, // 2KB
  4096, // 4KB - medium responses
  8192, // 8KB
  16384, // 16KB - large responses
  32768, // 32KB
  65536, // 64KB - very large responses
  131072, // 128KB
  262144, // 256KB - extra large responses
];

/**
 * Padding marker to distinguish padding from actual content
 */
const PADDING_MARKER = '\x00'; // Null byte - safe for JSON strings

/**
 * Pad response content to the next size class
 *
 * @param content - The response content to pad
 * @returns Padded content
 */
export function padResponse(content: string): string {
  const currentSize = Buffer.byteLength(content, 'utf8');

  // Find the next size class
  const targetSize = SIZE_CLASSES.find((size) => size >= currentSize);

  // If content is larger than all size classes, pad to next power of 2
  const finalTargetSize =
    targetSize ?? Math.pow(2, Math.ceil(Math.log2(currentSize)));

  // Calculate padding needed
  const paddingSize = finalTargetSize - currentSize;

  if (paddingSize <= 0) {
    return content;
  }

  // Add padding marker followed by null bytes
  // Using JSON-safe padding by encoding as a base64 comment-like string
  const padding = PADDING_MARKER.repeat(paddingSize);

  return content + padding;
}

/**
 * Remove padding from response content
 *
 * @param paddedContent - The padded response content
 * @returns Original content without padding
 */
export function unpadResponse(paddedContent: string): string {
  // Find the first padding marker and truncate there
  const paddingStart = paddedContent.indexOf(PADDING_MARKER);

  if (paddingStart === -1) {
    return paddedContent;
  }

  return paddedContent.substring(0, paddingStart);
}

/**
 * Get the size class that a given content length would be padded to
 *
 * @param contentLength - The length of the content in bytes
 * @returns The target size class
 */
export function getSizeClass(contentLength: number): number {
  const targetSize = SIZE_CLASSES.find((size) => size >= contentLength);
  return targetSize ?? Math.pow(2, Math.ceil(Math.log2(contentLength)));
}

/**
 * Calculate padding overhead as a percentage
 *
 * @param originalSize - Original content size
 * @param paddedSize - Padded content size
 * @returns Padding overhead as a percentage (0-100)
 */
export function calculatePaddingOverhead(
  originalSize: number,
  paddedSize: number,
): number {
  if (originalSize === 0) return 0;
  return ((paddedSize - originalSize) / originalSize) * 100;
}
