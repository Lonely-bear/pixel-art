/** Decode standard base64 without relying on Node's Buffer or a DOM API. */
export function decodeBase64(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('Invalid base64 data: expected standard base64 characters');
  }
  const firstPad = cleaned.indexOf('=');
  const data = firstPad >= 0 ? cleaned.slice(0, firstPad) : cleaned;
  if (data.length % 4 === 1) throw new Error('Invalid base64 data length');
  const padded = data + '='.repeat((4 - (data.length % 4)) % 4);
  const output = new Uint8Array((padded.length / 4) * 3);
  let out = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const a = base64Value(padded.charCodeAt(i));
    const b = base64Value(padded.charCodeAt(i + 1));
    const c = padded[i + 2] === '=' ? 0 : base64Value(padded.charCodeAt(i + 2));
    const d = padded[i + 3] === '=' ? 0 : base64Value(padded.charCodeAt(i + 3));
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Invalid base64 data character');
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    output[out++] = (chunk >> 16) & 255;
    if (padded[i + 2] !== '=') output[out++] = (chunk >> 8) & 255;
    if (padded[i + 3] !== '=') output[out++] = chunk & 255;
  }
  return output.slice(0, out);
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Small helper for binary-backed command summaries. */
export function base64Bytes(input: string): number {
  return decodeBase64(input).byteLength;
}
