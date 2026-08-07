import crypto from "node:crypto";

/**
 * SHA-256 hex digest of a string. Used by the web capability gateway to hash
 * session IDs and other metadata so raw values never appear in receipts.
 *
 * @param value - The string to hash.
 * @returns A 64-character lowercase hex string.
 */
export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
