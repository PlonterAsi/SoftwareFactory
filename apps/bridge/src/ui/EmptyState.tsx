import type { ReactNode } from "react";

/**
 * What a screen says when it has nothing yet: what will appear here, and the one thing to do
 * to get there. Never just "No data".
 */
export function EmptyState({ title, children, action, compact }: { title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state${compact ? " compact" : ""}`} role="status">
      <svg className="es-mark" viewBox="0 0 40 40" aria-hidden>
        <path d="M4 12V4h8M28 4h8v8M36 28v8h-8M12 36H4v-8" />
        <circle cx="20" cy="20" r="3" />
      </svg>
      <div className="es-title">{title}</div>
      {children && <div className="es-body">{children}</div>}
      {action && <div className="es-action">{action}</div>}
    </div>
  );
}
