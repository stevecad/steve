/**
 * The line of main.tsx a failed circuit build points at, and what the editor says there. The electronics kernel places
 * its errors as `Error evaluating "main.tsx" at 3:43: …` (or `at line 3`), then a code frame and a `Hint: …` line;
 * tscircuit's own say `Syntax error in "main.tsx" at 1:19: …`, stack frames `main.tsx:12:5`, or `line 12`. An error
 * placed in another file marks none of main.tsx's own lines (it shows on line 1).
 */
export function circuitError(error: string): { line: number; message: string } {
  const head = error.trim().split('\n')[0].slice(0, 400);
  const hint = /^Hint: .*$/m.exec(error)?.[0];
  const message = hint ? `${head} ${hint.slice(0, 300)}` : head;
  const placed = /"([^"]+)" at (?:(\d+):\d+|line (\d+))/.exec(error);
  if (placed) return { line: placed[1] === 'main.tsx' ? Number(placed[2] ?? placed[3]) : 1, message };
  const at = /main\.tsx[:(](\d+)/.exec(error) ?? /\bat (\d+):(\d+)/.exec(error) ?? /line (\d+)/i.exec(error);
  return { line: at ? Number(at[1]) : 1, message };
}
