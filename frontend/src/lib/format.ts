export function formatMYR(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
}
