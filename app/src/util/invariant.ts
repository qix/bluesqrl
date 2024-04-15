import { format } from "util";

export function invariant(
  condition: any,
  message?: string,
  ...args: any[]
): asserts condition {
  if (!condition) {
    if (args.length) {
      message = format(message, ...args);
    }
    throw new Error(message ?? "Invariant failed");
  }
}
