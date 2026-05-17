import { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState, forwardRef, useImperativeHandle } from "react";
import type { ChatMessage, MdModules, ChatDisplayMode } from "../utils/chatTypes";
import { MessageBubble } from "./MessageBubble";
import { FlatMessageItem } from "./FlatMessageItem";

const CHAT_RENDER_MESSAGE_LIMIT = 100;
const CHAT_RENDER_CHAR_BUDGET = 240_000;

function cappedAdd(total: number, amount: number, limit: number) {
  return Math.min(limit, total + Math.max(0, amount));
}

function estimateUnknownChars(value: unknown, limit: number, depth = 0): number {
  if (limit <= 0) return 0;
  if (typeof value === "string") return Math.min(value.length, limit);
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (!value || typeof value !== "object" || depth >= 6) return 0;

  let chars = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      chars = cappedAdd(chars, estimateUnknownChars(item, limit - chars, depth + 1), limit);
      if (chars >= limit) break;
    }
    return chars;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["content", "thinking", "thinkingChain", "toolCalls", "todo", "artifacts", "sources", "mcpCalls", "result", "args", "entries"] as const) {
    chars = cappedAdd(chars, estimateUnknownChars(record[key], limit - chars, depth + 1), limit);
    if (chars >= limit) break;
  }
  return chars;
}

// Identity-keyed cache. ChatMessage is replaced (not mutated) on every patch,
// so once cached, the value stays correct for the lifetime of that object.
// New objects (e.g. the currently streaming assistant message after each
// delta) compute fresh; the rest of the conversation hits the cache.
const messageCharCache = new WeakMap<ChatMessage, number>();

function estimateMessageRenderCharsCached(msg: ChatMessage): number {
  const cached = messageCharCache.get(msg);
  if (cached !== undefined) return cached;
  // Cap the walk at the global char budget — we don't need exact char counts
  // beyond it (any single message that exceeds the budget already dominates
  // the window decision on its own).
  const value = Math.max(1, estimateUnknownChars(msg, CHAT_RENDER_CHAR_BUDGET));
  messageCharCache.set(msg, value);
  return value;
}

function resolveRenderStartIndex(messages: ChatMessage[]): number {
  let visibleCount = 0;
  let renderChars = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (visibleCount >= CHAT_RENDER_MESSAGE_LIMIT) break;
    const messageChars = estimateMessageRenderCharsCached(messages[index]);
    if (visibleCount > 0 && renderChars + messageChars > CHAT_RENDER_CHAR_BUDGET) break;
    renderChars += messageChars;
    visibleCount += 1;
    startIndex = index;
  }
  return startIndex;
}

export interface MessageListHandle {
  scrollToIndex: (index: number, align?: "start" | "center" | "end") => void;
  scrollToBottom: (behavior?: "auto" | "smooth") => void;
  /** Keep followOutput returning true until cancelFollow is called, even if user scrolled up. */
  forceFollow: () => void;
  /** Stop forced following (call when streaming ends). */
  cancelFollow: () => void;
  /** Whether the user is currently scrolled to the bottom. */
  isAtBottom: () => boolean;
  /** Save current scroll position — call before mutating messages while user is scrolled up. */
  saveScrollPosition: () => void;
  /** Restore previously saved scroll position. */
  restoreScrollPosition: () => void;
}

export interface MessageListProps {
  messages: ChatMessage[];
  displayMode: ChatDisplayMode;
  showChain: boolean;
  apiBaseUrl?: string;
  mdModules?: MdModules | null;
  isStreaming: boolean;
  searchHighlight?: string;
  conversationId?: string;
  httpApiBase?: () => string;
  onPlanStepAction?: (action: "skip" | "retry", stepIdx: number, description: string) => void;
  onAskAnswer?: (msgId: string, answer: string) => void;
  onRetry?: (msgId: string) => void;
  onEdit?: (msgId: string) => void;
  onRegenerate?: (msgId: string) => void;
  onRewind?: (msgId: string) => void;
  onFork?: (msgId: string) => void;
  onSaveMemory?: (msgId: string) => void;
  onSkipStep?: () => void;
  onImagePreview?: (displayUrl: string, downloadUrl: string, name: string) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onLoadOlder?: () => void;
  hasMoreBefore?: boolean;
  loadingOlder?: boolean;
}

function applySearchHighlights(container: HTMLElement, query: string) {
  const css = globalThis.CSS as typeof CSS & { highlights?: Map<string, Highlight> };
  if (!css?.highlights) return;
  const q = query.trim().toLowerCase();
  if (!q) { css.highlights.delete("msg-search"); return; }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent?.toLowerCase() ?? "";
    let pos = 0;
    while (pos < text.length) {
      const idx = text.indexOf(q, pos);
      if (idx === -1) break;
      const range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + q.length);
      ranges.push(range);
      pos = idx + q.length;
    }
  }
  css.highlights.set("msg-search", new Highlight(...ranges));
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages,
    displayMode,
    showChain,
    apiBaseUrl,
    mdModules,
    isStreaming,
    searchHighlight,
    onAskAnswer,
    onRetry,
    onEdit,
    onRegenerate,
    onRewind,
    onFork,
    onSaveMemory,
    onSkipStep,
    onImagePreview,
    onAtBottomChange,
    conversationId,
    httpApiBase,
    onPlanStepAction,
    onLoadOlder,
    hasMoreBefore = false,
    loadingOlder = false,
  },
  ref,
) {
  const scrollerElRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const forceFollowRef = useRef(false);
  const atBottomRef = useRef(true);
  const savedScrollPositionRef = useRef<{ top: number; height: number } | null>(null);
  const pendingScrollRef = useRef<{ id: string; align: "start" | "center" | "end" } | null>(null);
  const [renderAllMessages, setRenderAllMessages] = useState(false);
  const searchActive = Boolean(searchHighlight?.trim());

  const renderWindow = useMemo(() => {
    if (renderAllMessages || searchActive) {
      return { startIndex: 0, hiddenCount: 0, visibleMessages: messages };
    }
    const startIndex = resolveRenderStartIndex(messages);
    return {
      startIndex,
      hiddenCount: startIndex,
      visibleMessages: messages.slice(startIndex),
    };
  }, [messages, renderAllMessages, searchActive]);

  useEffect(() => {
    setRenderAllMessages(false);
    // Drop any pending scroll target from the previous conversation so a later
    // re-visit doesn't trigger an unrequested scroll if the same msg id is
    // still reachable. itemRefs are torn down by the unmount cycle anyway.
    pendingScrollRef.current = null;
  }, [conversationId]);

  // Consume any pending scroll target queued by scrollToIndex while the
  // target was hidden by the render budget. We run on every renderWindow
  // change so we catch the moment the message becomes mounted.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    const el = itemRefs.current.get(pending.id);
    if (!el) return;
    el.scrollIntoView({
      block: pending.align === "end" ? "end" : pending.align === "center" ? "center" : "start",
      behavior: "smooth",
    });
    pendingScrollRef.current = null;
  }, [renderWindow]);

  const emitAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    onAtBottomChange?.(atBottom);
  }, [onAtBottomChange]);

  const computeAtBottom = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  }, []);

  const syncAtBottomState = useCallback(() => {
    emitAtBottomChange(computeAtBottom());
  }, [computeAtBottom, emitAtBottomChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const css = globalThis.CSS as typeof CSS & { highlights?: Map<string, Highlight> };
    if (!css?.highlights) return;

    const q = searchHighlight?.trim().toLowerCase() ?? "";
    applySearchHighlights(el, q);

    if (!q) return;

    const observer = new MutationObserver(() => applySearchHighlights(el, q));
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      css.highlights.delete("msg-search");
    };
  }, [searchHighlight, messages]);

  const scrollToAbsoluteBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollerElRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number, align: "start" | "center" | "end" = "center") => {
      const msg = messages[index];
      if (!msg) return;
      const target = itemRefs.current.get(msg.id);
      if (target) {
        target.scrollIntoView({
          block: align === "end" ? "end" : align === "center" ? "center" : "start",
          behavior: "smooth",
        });
        return;
      }
      // Target is not mounted. Two reasons:
      //   1. It exists in `messages` but the render budget hid it → expand
      //      the window and finish the scroll in a layout effect once it mounts.
      //   2. It is older than what we hold locally → ask host to page in
      //      history from the backend.
      if (index < renderWindow.startIndex) {
        pendingScrollRef.current = { id: msg.id, align };
        setRenderAllMessages(true);
        return;
      }
      onLoadOlder?.();
    },
    scrollToBottom: scrollToAbsoluteBottom,
    forceFollow: () => {
      forceFollowRef.current = true;
      requestAnimationFrame(() => scrollToAbsoluteBottom());
    },
    cancelFollow: () => { forceFollowRef.current = false; },
    isAtBottom: () => atBottomRef.current,
    saveScrollPosition: () => {
      const el = scrollerElRef.current;
      if (el) savedScrollPositionRef.current = { top: el.scrollTop, height: el.scrollHeight };
    },
    restoreScrollPosition: () => {
      const el = scrollerElRef.current;
      if (el && savedScrollPositionRef.current !== null) {
        const prev = savedScrollPositionRef.current;
        el.scrollTop = prev.top + (el.scrollHeight - prev.height);
        savedScrollPositionRef.current = null;
        syncAtBottomState();
      }
    },
  }), [messages, renderWindow.startIndex, onLoadOlder, scrollToAbsoluteBottom, syncAtBottomState]);

  useEffect(() => {
    if (!isStreaming) {
      forceFollowRef.current = false;
    }
  }, [isStreaming]);

  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el) return;

    const onScroll = () => {
      syncAtBottomState();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    syncAtBottomState();
    return () => el.removeEventListener("scroll", onScroll);
  }, [syncAtBottomState]);

  useLayoutEffect(() => {
    if (forceFollowRef.current || atBottomRef.current) {
      scrollToAbsoluteBottom();
      emitAtBottomChange(true);
      return;
    }
    syncAtBottomState();
  }, [messages, scrollToAbsoluteBottom, syncAtBottomState, emitAtBottomChange]);

  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (forceFollowRef.current || atBottomRef.current) {
        scrollToAbsoluteBottom();
        emitAtBottomChange(true);
      } else {
        syncAtBottomState();
      }
    });

    observer.observe(el);
    const firstChild = el.firstElementChild;
    if (firstChild instanceof HTMLElement) observer.observe(firstChild);
    return () => observer.disconnect();
  }, [messages.length, scrollToAbsoluteBottom, syncAtBottomState, emitAtBottomChange]);

  const computeItemKey = useCallback((_index: number, msg: ChatMessage) => msg.id, []);

  const itemContent = useCallback((index: number, msg: ChatMessage) => {
    const isLast = index === messages.length - 1;
    const Component = displayMode === "flat" ? FlatMessageItem : MessageBubble;
    return (
      <div data-msg-idx={index}>
        <Component
          msg={msg}
          isLast={isLast}
          apiBaseUrl={apiBaseUrl}
          showChain={showChain}
          mdModules={mdModules}
          onAskAnswer={onAskAnswer}
          onRetry={onRetry}
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          onRewind={onRewind}
          onSkipStep={onSkipStep}
          onImagePreview={onImagePreview}
          conversationId={conversationId}
          httpApiBase={httpApiBase}
          onPlanStepAction={onPlanStepAction}
        />
      </div>
    );
  }, [
    messages.length, displayMode, apiBaseUrl, showChain, mdModules,
    onAskAnswer, onRetry, onEdit, onRegenerate, onRewind, onSkipStep, onImagePreview,
    conversationId, httpApiBase, onPlanStepAction,
  ]);

  const Footer = useCallback(() => <div style={{ height: 32 }} />, []);

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scrollerElRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}
      >
        <div>
          {hasMoreBefore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}>
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={loadingOlder}
                style={{
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--text-muted)",
                  borderRadius: 999,
                  padding: "6px 12px",
                  fontSize: 12,
                  cursor: loadingOlder ? "default" : "pointer",
                  opacity: loadingOlder ? 0.7 : 1,
                }}
              >
                {loadingOlder ? "正在加载更早消息..." : "加载更早消息"}
              </button>
            </div>
          )}
          {renderWindow.hiddenCount > 0 && (
            <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
              <div style={{
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text-muted)",
                borderRadius: 999,
                padding: "5px 12px",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}>
                <span>已隐藏更早的 {renderWindow.hiddenCount} 条消息以保持流式显示流畅</span>
                <button
                  type="button"
                  onClick={() => setRenderAllMessages(true)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--brand)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 12,
                  }}
                >
                  显示已隐藏消息
                </button>
              </div>
            </div>
          )}
          {renderWindow.visibleMessages.map((msg, visibleIndex) => {
            const originalIndex = renderWindow.startIndex + visibleIndex;
            return (
            <div
              key={computeItemKey(originalIndex, msg)}
              ref={(el) => {
                if (el) itemRefs.current.set(msg.id, el);
                else itemRefs.current.delete(msg.id);
              }}
            >
              {itemContent(originalIndex, msg)}
            </div>
            );
          })}
          <Footer />
        </div>
      </div>
    </div>
  );
});
