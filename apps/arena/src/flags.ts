/** A command-line flag that must be a whole number: 1 or more, or 0 or more with `allowZero`. */
export function positiveInt(text: string | undefined, flag: string, allowZero = false): number {
  const n = Number(text);
  if (text === undefined || text.trim() === "" || !Number.isInteger(n) || n < (allowZero ? 0 : 1))
    throw new Error(`${flag} must be a whole number`);
  return n;
}
