// Pending bridge requests: the DO sends a command to the Mac daemon over its
// bridge-tagged WebSocket and awaits the matching result frame. Same shape as
// the device MCP registry — a correlation id, a deadline, and a promise.

export const BRIDGE_COMMAND_TIMEOUT_MILLISECONDS = 10_000;

type PendingBridgeRequest = {
  readonly resolve: (output: string) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
};

export type BridgeRequestRegistry = {
  readonly createRequest: (requestId: string) => Promise<string>;
  readonly resolveRequest: (requestId: string, output: string) => boolean;
  readonly rejectRequest: (requestId: string, message: string) => boolean;
};

export function createBridgeRequestRegistry(): BridgeRequestRegistry {
  const pendingRequestMap = new Map<string, PendingBridgeRequest>();

  return {
    createRequest(requestId: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          pendingRequestMap.delete(requestId);
          reject(new Error('bridge command timed out'));
        }, BRIDGE_COMMAND_TIMEOUT_MILLISECONDS);
        pendingRequestMap.set(requestId, { resolve, reject, timeoutHandle });
      });
    },
    resolveRequest(requestId: string, output: string): boolean {
      const pending = pendingRequestMap.get(requestId);
      if (pending === undefined) {
        return false;
      }
      clearTimeout(pending.timeoutHandle);
      pendingRequestMap.delete(requestId);
      pending.resolve(output);
      return true;
    },
    rejectRequest(requestId: string, message: string): boolean {
      const pending = pendingRequestMap.get(requestId);
      if (pending === undefined) {
        return false;
      }
      clearTimeout(pending.timeoutHandle);
      pendingRequestMap.delete(requestId);
      pending.reject(new Error(message));
      return true;
    },
  };
}
