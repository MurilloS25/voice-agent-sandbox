/** The first value of a Next.js search param, or undefined when absent or empty. */
export function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single ? single : undefined;
}
