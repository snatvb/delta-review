export interface RepoBox {
  repoId: string;
  top: number;
  height: number;
}

export function dropIndex(others: readonly RepoBox[], y: number): number {
  const at = others.findIndex((box) => y < box.top + box.height / 2);
  return at === -1 ? others.length : at;
}

export function slides(others: readonly RepoBox[], from: number, slot: number, draggedHeight: number): number[] {
  return others.map((_, j) => {
    const indexBefore = j < from ? j : j + 1;
    const indexAfter = j < slot ? j : j + 1;
    return indexBefore === indexAfter ? 0 : indexBefore < indexAfter ? draggedHeight : -draggedHeight;
  });
}
