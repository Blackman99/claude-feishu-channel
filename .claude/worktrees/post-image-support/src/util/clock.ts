export type TimeoutHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): TimeoutHandle {
    const id = setTimeout(callback, delayMs) as unknown as number;
    return { id };
  }

  clearTimeout(handle: TimeoutHandle): void {
    clearTimeout(handle.id as unknown as NodeJS.Timeout);
  }
}

interface FakeTimer {
  readonly id: number;
  readonly deadline: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private currentTime: number;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  constructor(initialTime: number = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): TimeoutHandle {
    const id = this.nextId++;
    this.timers.push({
      id,
      deadline: this.currentTime + delayMs,
      callback,
      cancelled: false,
    });
    return { id };
  }

  clearTimeout(handle: TimeoutHandle): void {
    const timer = this.timers.find((t) => t.id === handle.id);
    if (timer) timer.cancelled = true;
  }

  advance(deltaMs: number): void {
    const targetTime = this.currentTime + deltaMs;
    while (true) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.deadline <= targetTime)
        .sort((a, b) => a.deadline - b.deadline);
      if (due.length === 0) break;
      const next = due[0]!;
      this.currentTime = next.deadline;
      next.cancelled = true; // mark fired
      next.callback();
    }
    this.currentTime = targetTime;
  }
}
