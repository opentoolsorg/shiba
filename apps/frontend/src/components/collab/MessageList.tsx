import type { JSX, ReactNode } from "react";

export function MessageList({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      role="log"
      aria-label="Conversation messages"
      className="flex min-h-64 flex-1 flex-col gap-4 overflow-y-auto p-4 xl:max-h-[60vh]"
    >
      {children}
    </div>
  );
}
