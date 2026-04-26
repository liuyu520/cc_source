/**
 * 轻量优先级队列 — 纯 TS，无依赖。
 *
 * 用于 SideQueryScheduler 调度。元素按 priority 升序出队（数值越小越优先）。
 * 同优先级按入队顺序 FIFO。
 */

interface Entry<T> {
  priority: number
  seq: number
  item: T
}

export class PriorityQueue<T> {
  private heap: Entry<T>[] = []
  private counter = 0

  get size(): number {
    return this.heap.length
  }

  push(item: T, priority: number): void {
    const entry: Entry<T> = { priority, seq: this.counter++, item }
    this.heap.push(entry)
    this.bubbleUp(this.heap.length - 1)
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined
    const top = this.heap[0]
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      this.heap[0] = last
      this.bubbleDown(0)
    }
    return top.item
  }

  peek(): T | undefined {
    return this.heap[0]?.item
  }

  private less(a: Entry<T>, b: Entry<T>): boolean {
    if (a.priority !== b.priority) return a.priority < b.priority
    return a.seq < b.seq
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(this.heap[i], this.heap[parent])) {
        ;[this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]]
        i = parent
      } else break
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length
    while (true) {
      const l = i * 2 + 1
      const r = i * 2 + 2
      let best = i
      if (l < n && this.less(this.heap[l], this.heap[best])) best = l
      if (r < n && this.less(this.heap[r], this.heap[best])) best = r
      if (best === i) break
      ;[this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]]
      i = best
    }
  }
}
