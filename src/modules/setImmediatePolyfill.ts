if (typeof setImmediate === "undefined") {
  (globalThis as any).setImmediate = (
    fn: (...args: any[]) => void,
    ...args: any[]
  ) => setTimeout(fn, 0, ...args);
}

export {};
