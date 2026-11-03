/** Renderer — diff de líneas para el visor del chat (sin dependencias).
 *  Solo archivos existentes modificados: el core no envía diff para nuevos. */
export interface DiffRow {
  kind: "same" | "change" | "add" | "del";
  left?: { no: number; text: string };
  right?: { no: number; text: string };
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_LINES = 1200;
const MAX_CELLS = 400_000;

function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function pairBlock(deleted: Array<{ no: number; text: string }>, added: Array<{ no: number; text: string }>): DiffRow[] {
  const rows: DiffRow[] = [];
  const count = Math.max(deleted.length, added.length);
  for (let i = 0; i < count; i++) {
    const left = deleted[i];
    const right = added[i];
    rows.push({
      kind: left && right ? "change" : left ? "del" : "add",
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
    });
  }
  return rows;
}

export function diffLines(before: string, after: string): DiffResult {
  const a = linesOf(before);
  const b = linesOf(after);
  const truncated = a.length > MAX_LINES || b.length > MAX_LINES;
  const aa = a.slice(0, MAX_LINES);
  const bb = b.slice(0, MAX_LINES);

  let start = 0;
  while (start < aa.length && start < bb.length && aa[start] === bb[start]) start++;
  let endA = aa.length - 1;
  let endB = bb.length - 1;
  while (endA >= start && endB >= start && aa[endA] === bb[endB]) {
    endA--;
    endB--;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ kind: "same", left: { no: i + 1, text: aa[i]! }, right: { no: i + 1, text: bb[i]! } });

  const midA = aa.slice(start, endA + 1);
  const midB = bb.slice(start, endB + 1);
  let added = 0;
  let removed = 0;

  if (midA.length * midB.length <= MAX_CELLS) {
    const n = midA.length;
    const m = midB.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    let delBlock: Array<{ no: number; text: string }> = [];
    let addBlock: Array<{ no: number; text: string }> = [];
    const flush = (): void => {
      if (delBlock.length === 0 && addBlock.length === 0) return;
      removed += delBlock.length;
      added += addBlock.length;
      rows.push(...pairBlock(delBlock, addBlock));
      delBlock = [];
      addBlock = [];
    };
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        flush();
        rows.push({ kind: "same", left: { no: start + i + 1, text: midA[i]! }, right: { no: start + j + 1, text: midB[j]! } });
        i++;
        j++;
      } else if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
        delBlock.push({ no: start + i + 1, text: midA[i]! });
        i++;
      } else {
        addBlock.push({ no: start + j + 1, text: midB[j]! });
        j++;
      }
    }
    flush();
  } else {
    // Archivos grandes: muestra el bloque completo sustituido, sin LCS.
    removed = midA.length;
    added = midB.length;
    rows.push(...pairBlock(midA.map((text, i) => ({ no: start + i + 1, text })), midB.map((text, i) => ({ no: start + i + 1, text }))));
  }

  for (let i = endA + 1, j = endB + 1; i < aa.length && j < bb.length; i++, j++) {
    rows.push({ kind: "same", left: { no: i + 1, text: aa[i]! }, right: { no: j + 1, text: bb[j]! } });
  }
  return { rows, added, removed, truncated };
}
