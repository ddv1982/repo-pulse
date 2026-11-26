type Lane = { id: string; color: number };
type Segment = { from: number; to: number; color: number };
type Commit = { id: string; parents: string[] };

export function layoutGitGraph(commits: Commit[]) {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let width = 1;
  const rows = commits.map(({ id, parents }) => {
    const found = lanes.findIndex(lane => lane.id === id);
    const slot = found < 0 ? lanes.length : found;
    const color = lanes[slot]?.color ?? nextColor++;
    const incoming: Segment[] = [];
    const through: Segment[] = [];
    const next: Lane[] = [];
    const first = parents[0];
    let firstSlot = -1;
    for (const [index, lane] of lanes.entries()) {
      if (lane.id === id) {
        incoming.push({ from: index, to: slot, color: lane.color });
        if (index === slot && first) {
          firstSlot = next.length;
          next.push({ id: first, color });
        }
      } else {
        through.push({ from: index, to: next.length, color: lane.color });
        next.push(lane);
      }
    }
    if (first && firstSlot < 0) {
      firstSlot = next.length;
      next.push({ id: first, color });
    }
    const outgoing = parents.map((parent, index) => {
      let to = index === 0 ? firstSlot : next.findIndex(lane => lane.id === parent);
      if (to < 0) {
        to = next.length;
        next.push({ id: parent, color: nextColor++ });
      }
      return { from: slot, to, color: next[to]?.color ?? color };
    });
    width = Math.max(width, slot + 1, next.length);
    lanes = next;
    return { slot, color, incoming, through, outgoing };
  });
  return { rows, width };
}
