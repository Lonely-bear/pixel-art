/** Maximum accepted base64 wire size, including insignificant whitespace. */
export const MAX_BASE64_INPUT_LENGTH = 24 * 1024 * 1024;

interface ParsedBase64 {
  /** Input with whitespace removed; the data portion ends before any padding. */
  cleaned: string;
  dataEnd: number;
  padding: number;
  byteLength: number;
}

/** Parse and validate standard, optionally unpadded base64 without allocating decoded bytes. */
function parseBase64(input: string): ParsedBase64 {
  if (input.length > MAX_BASE64_INPUT_LENGTH) {
    throw new Error(
      `Base64 data is too large: ${input.length} characters exceeds the ${MAX_BASE64_INPUT_LENGTH} character limit`,
    );
  }
  const cleaned = input.replace(/\s+/g, '');
  let dataEnd = cleaned.length;
  let padding = 0;
  while (dataEnd > 0 && cleaned[dataEnd - 1] === '=') {
    dataEnd--;
    padding++;
  }
  if (padding > 2) throw new Error('Invalid base64 data: at most two padding characters are allowed');

  for (let i = 0; i < dataEnd; i++) {
    if (base64Value(cleaned.charCodeAt(i)) < 0) {
      throw new Error('Invalid base64 data: expected standard base64 characters');
    }
  }

  const remainder = dataEnd % 4;
  if (padding > 0 && cleaned.length % 4 !== 0) {
    throw new Error('Invalid base64 data: padded input must have a length divisible by four');
  }
  if ((padding === 1 && remainder !== 3) || (padding === 2 && remainder !== 2) || (padding === 0 && remainder === 1)) {
    throw new Error('Invalid base64 data length');
  }
  if (dataEnd > 0 && (remainder === 2 || remainder === 3)) {
    const last = base64Value(cleaned.charCodeAt(dataEnd - 1));
    const discardedBits = remainder === 2 ? 0x0f : 0x03;
    if ((last & discardedBits) !== 0) {
      throw new Error('Invalid base64 data: non-zero discarded bits');
    }
  }

  const wholeQuartets = Math.floor(dataEnd / 4);
  const tailBytes = remainder === 2 ? 1 : remainder === 3 ? 2 : 0;
  return { cleaned, dataEnd, padding, byteLength: wholeQuartets * 3 + tailBytes };
}

/** Return the decoded byte length while validating syntax, without allocating the output. */
export function base64ByteLength(input: string): number {
  return parseBase64(input).byteLength;
}

/** Decode standard base64 without relying on Node's Buffer or a DOM API. */
export function decodeBase64(input: string): Uint8Array {
  const parsed = parseBase64(input);
  const output = new Uint8Array(parsed.byteLength);
  let out = 0;
  for (let i = 0; i < parsed.dataEnd; i += 4) {
    const remaining = parsed.dataEnd - i;
    const a = base64Value(parsed.cleaned.charCodeAt(i));
    const b = base64Value(parsed.cleaned.charCodeAt(i + 1));
    const c = remaining > 2 ? base64Value(parsed.cleaned.charCodeAt(i + 2)) : 0;
    const d = remaining > 3 ? base64Value(parsed.cleaned.charCodeAt(i + 3)) : 0;
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    output[out++] = (chunk >> 16) & 255;
    if (remaining > 2) output[out++] = (chunk >> 8) & 255;
    if (remaining > 3) output[out++] = chunk & 255;
  }
  return output;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Backwards-compatible descriptive alias for callers that only need the size. */
export const base64Bytes = base64ByteLength;
