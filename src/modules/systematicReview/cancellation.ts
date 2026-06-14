export interface ReviewCancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

class MutableReviewCancellationSignal implements ReviewCancellationSignal {
  aborted = false;
  private listeners = new Set<() => void>();

  addEventListener(type: "abort", listener: () => void): void {
    if (type !== "abort") return;
    this.listeners.add(listener);
  }

  removeEventListener(type: "abort", listener: () => void): void {
    if (type !== "abort") return;
    this.listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const listeners = Array.from(this.listeners);
    this.listeners.clear();
    listeners.forEach((listener) => listener());
  }
}

export class ReviewCancellationController {
  readonly signal = new MutableReviewCancellationSignal();

  abort(): void {
    this.signal.abort();
  }
}
