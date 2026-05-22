/**
 * A safe base64/base64url encoder that works in Zotero's environment
 * and handles non-ASCII characters correctly.
 */

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  let i: number;
  const l = bytes.length;
  for (i = 2; i < l; i += 3) {
    result += BASE64_CHARS[bytes[i - 2] >> 2];
    result += BASE64_CHARS[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
    result += BASE64_CHARS[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)];
    result += BASE64_CHARS[bytes[i] & 0x3f];
  }
  if (i === l + 1) {
    // 1 octet missing
    result += BASE64_CHARS[bytes[i - 2] >> 2];
    result += BASE64_CHARS[(bytes[i - 2] & 0x03) << 4];
    result += "==";
  } else if (i === l) {
    // 2 octets missing
    result += BASE64_CHARS[bytes[i - 2] >> 2];
    result += BASE64_CHARS[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
    result += BASE64_CHARS[(bytes[i - 1] & 0x0f) << 2];
    result += "=";
  }
  return result;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let result = "";
  let i: number;
  const l = bytes.length;
  for (i = 2; i < l; i += 3) {
    result += BASE64URL_CHARS[bytes[i - 2] >> 2];
    result +=
      BASE64URL_CHARS[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
    result += BASE64URL_CHARS[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)];
    result += BASE64URL_CHARS[bytes[i] & 0x3f];
  }
  if (i === l + 1) {
    result += BASE64URL_CHARS[bytes[i - 2] >> 2];
    result += BASE64URL_CHARS[(bytes[i - 2] & 0x03) << 4];
  } else if (i === l) {
    result += BASE64URL_CHARS[bytes[i - 2] >> 2];
    result +=
      BASE64URL_CHARS[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
    result += BASE64URL_CHARS[(bytes[i - 1] & 0x0f) << 2];
  }
  return result;
}

/**
 * Safely encode a string to base64, handling non-ASCII characters.
 */
export function stringToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return bytesToBase64(bytes);
}
