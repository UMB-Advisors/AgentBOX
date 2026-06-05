// Small LCS-based line diff for the inbox EditDiff UI. Pure, no deps. Used
// only for short draft bodies (≤ ~4k chars) so the O(m*n) DP table is fine.
// Ported verbatim from mailbox-dashboard lib/diff/line-diff.ts (STAQPRO-331 #4).

export type DiffOp = "equal" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[0..i) and b[0..j).
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrace from (m, n) to (0, 0).
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ op: "equal", text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ op: "remove", text: a[i - 1] });
      i--;
    } else {
      out.push({ op: "add", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ op: "remove", text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ op: "add", text: b[j - 1] });
    j--;
  }
  return out.reverse();
}

/** Count add/remove ops — used to show "+N / -M" without rendering the diff. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "remove") removed++;
  }
  return { added, removed };
}
