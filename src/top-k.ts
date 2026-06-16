export type BetterThan<T> = (left: T, right: T) => boolean;

/** Keeps only the best K items without sorting the full candidate set. */
export class TopK<T> {
  private readonly heap: T[] = [];

  constructor(
    private readonly limit: number,
    private readonly betterThan: BetterThan<T>,
  ) {}

  push(item: T): void {
    if (this.limit <= 0) return;

    if (this.heap.length < this.limit) {
      this.heap.push(item);
      this.bubbleUp(this.heap.length - 1);
      return;
    }

    const worst = this.heap[0]!;
    if (!this.betterThan(item, worst)) {
      return;
    }

    this.heap[0] = item;
    this.sinkDown(0);
  }

  valuesBestFirst(): T[] {
    return [...this.heap].sort((left, right) => {
      if (this.betterThan(left, right)) return -1;
      if (this.betterThan(right, left)) return 1;
      return 0;
    });
  }

  private worseThan(left: T, right: T): boolean {
    return this.betterThan(right, left);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.worseThan(this.heap[index]!, this.heap[parent]!)) {
        break;
      }
      this.swap(index, parent);
      index = parent;
    }
  }

  private sinkDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;

      if (left < this.heap.length && this.worseThan(this.heap[left]!, this.heap[worst]!)) {
        worst = left;
      }
      if (right < this.heap.length && this.worseThan(this.heap[right]!, this.heap[worst]!)) {
        worst = right;
      }
      if (worst === index) {
        break;
      }
      this.swap(index, worst);
      index = worst;
    }
  }

  private swap(left: number, right: number): void {
    const value = this.heap[left]!;
    this.heap[left] = this.heap[right]!;
    this.heap[right] = value;
  }
}
