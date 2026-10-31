/** How routing's times read (routing.ts): plain functions, so they're tested without a browser. */

/** "48 s", "3 min 13 s", "10 min", "1 h 5 min", "4 h": seconds are dropped from an hour on. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  if (total >= 3600) {
    const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const minutes = Math.floor(total / 60), rest = total % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** "1:12", "4:00:00": a running clock. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (total >= 3600) return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** "the 4-hour budget", "the 10-minute budget", "the 90 s budget". */
export function budgetText(seconds: number | null | undefined): string {
  if (!seconds) return 'its time budget';
  if (seconds % 3600 === 0) return `the ${seconds / 3600}-hour budget`;
  if (seconds % 60 === 0) return `the ${seconds / 60}-minute budget`;
  return `the ${duration(seconds)} budget`;
}
