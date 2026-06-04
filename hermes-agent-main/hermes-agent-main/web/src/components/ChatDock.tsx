import { useCallback, useRef, type ReactNode } from "react";
import { MessageSquare, PanelRightClose, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { cn } from "@/lib/utils";

export const CHAT_WIDTH_MIN = 320;
export const CHAT_WIDTH_MAX = 1200;
export const CHAT_WIDTH_DEFAULT = 420;

/**
 * Clamp + coerce a chat-dock width. Never trusts the raw parse: NaN /
 * out-of-range values fall back to the default (the persisted
 * 'hermes-chat-width' could be stale or hand-edited).
 */
export function clampChatWidth(n: number): number {
  if (!Number.isFinite(n)) return CHAT_WIDTH_DEFAULT;
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, n));
}

interface ChatDockProps {
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  onWidthChange: (next: number) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  isMobile: boolean;
  children: ReactNode;
}

/**
 * Right-hand chat dock.
 *
 * The single ChatPage child is mounted exactly once and never moved in the
 * DOM — this wrapper only toggles CSS (display / fixed-overlay positioning)
 * so the PTY/WebSocket/xterm instance survive across collapse, resize, and
 * the mobile open/close transition. Never portal the host or branch into a
 * second tree for mobile.
 *
 * - Desktop (lg+): in-flow column. Expanded width comes from an inline style
 *   (Tailwind can't take a runtime utility value); collapsed shrinks to a
 *   `lg:w-10` rail via class. A left-edge pointer-drag handle resizes it.
 * - Mobile (<lg): a fixed full-screen translate-x drawer driven by
 *   `mobileOpen`. Collapse is a desktop-only concept and is ignored here.
 */
export default function ChatDock({
  collapsed,
  onToggle,
  width,
  onWidthChange,
  mobileOpen,
  onMobileClose,
  isMobile,
  children,
}: ChatDockProps) {
  // Drag state lives in refs so a move handler doesn't re-render per frame.
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only the primary button starts a drag.
      if (e.button !== 0) return;
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw if the pointer is already gone */
      }

      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      let latest = startWidthRef.current;

      const onMove = (ev: PointerEvent) => {
        // Handle is on the LEFT edge and the dock grows leftward, so a
        // rightward drag (positive delta) shrinks it — subtract the delta.
        latest = clampChatWidth(
          startWidthRef.current - (ev.clientX - startXRef.current),
        );
        onWidthChange(latest);
      };

      const finish = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        // Persist only on release — persisting per move would thrash
        // localStorage and jank the drag.
        onWidthChange(latest);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [width, onWidthChange],
  );

  // Inner content is display:flex only when actually visible — kept mounted
  // (display:none) otherwise so the PTY survives but stays hidden. This is the
  // pre-existing collapse contract, extended to the mobile drawer.
  const contentVisible = isMobile ? mobileOpen : !collapsed;

  // Expanded desktop width is driven inline; never on mobile (full-screen) and
  // never when collapsed (the lg:w-10 rail class owns that).
  const asideStyle =
    !isMobile && !collapsed ? { width } : undefined;

  return (
    <aside
      aria-label="Chat"
      style={asideStyle}
      className={cn(
        // Mobile: fixed full-screen translate-x drawer.
        "fixed inset-0 z-[45] flex flex-col",
        "transition-transform duration-200 ease-out",
        mobileOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
        // Desktop: in-flow column, reset the mobile fixed/transform/z chrome.
        "lg:static lg:inset-auto lg:z-auto lg:translate-x-0 lg:pointer-events-auto",
        "lg:flex lg:shrink-0",
        "border-l border-current/20 bg-background-base/95",
        collapsed && "lg:w-10",
      )}
    >
      {/* Left-edge drag handle — desktop only, suppressed when collapsed. */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          onPointerDown={handlePointerDown}
          className={cn(
            "hidden lg:block",
            "absolute inset-y-0 -left-0.5 z-10 w-1.5",
            "cursor-col-resize hover:bg-midground/20",
          )}
        />
      )}

      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-current/20 px-2">
        <span
          className={cn(
            "px-1 text-xs font-medium uppercase tracking-[0.14em] text-text-tertiary",
            collapsed && "lg:hidden",
          )}
        >
          Chat
        </span>

        {/* Mobile close (X). */}
        <Button
          ghost
          size="icon"
          onClick={onMobileClose}
          aria-label="Close chat"
          className="lg:hidden text-text-secondary hover:text-midground"
        >
          <X className="h-4 w-4" />
        </Button>

        {/* Desktop collapse toggle. */}
        <Button
          ghost
          size="icon"
          onClick={onToggle}
          aria-label={collapsed ? "Expand chat" : "Collapse chat"}
          className="hidden lg:flex text-text-secondary hover:text-midground"
        >
          {collapsed ? (
            <MessageSquare className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          contentVisible ? "flex" : "hidden",
        )}
      >
        {children}
      </div>
    </aside>
  );
}
