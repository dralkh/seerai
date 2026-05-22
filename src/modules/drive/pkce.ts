import { bytesToBase64Url } from "./utils";

export async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = bytesToBase64Url(bytes);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = bytesToBase64Url(new Uint8Array(hash));
  return { verifier, challenge };
}

export function extractCodeFromUrl(url: string): string | null {
  const qs = url.includes("?") ? url.split("?")[1] || "" : "";
  const params = new URLSearchParams(qs);
  return params.get("code");
}

export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64Url(bytes);
}
