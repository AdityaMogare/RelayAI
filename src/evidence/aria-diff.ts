export type AriaDiff = {
  added: string[];
  removed: string[];
};

export function ariaSnapshotDiff(before: string, after: string): AriaDiff {
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  return {
    added: [...afterLines].filter((line) => !beforeLines.has(line)),
    removed: [...beforeLines].filter((line) => !afterLines.has(line)),
  };
}
