/**
 * DiceVision session codes: 8 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789
 * (no 0/O/1/I/L), shown as XKRM-4N7B.
 */

const CODE_PATTERN = /^[A-Z2-9]{8}$/;

/** "xkrm-4n7b" -> "XKRM4N7B"; null when it isn't a session code. */
export function normalizeSessionCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return CODE_PATTERN.test(code) ? code : null;
}

/** "XKRM4N7B" -> "XKRM-4N7B" */
export function formatSessionCode(code: string): string {
  const clean = code.toUpperCase().replace(/[\s-]/g, "");
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
