import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import {
  type SiteContextItem,
  extractSiteContextBlocks,
  getSiteContextLabel,
} from "./site-context-chip";

/** Placeholder character representing a chip in plain-text coordinates */
const CHIP_CHAR = "\uFFFC";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Walk the contenteditable DOM and produce plain text (chips → CHIP_CHAR). */
function getPlainTextFromDom(container: HTMLElement): string {
  let text = "";

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;

    if (node.dataset.siteContextId) {
      text += CHIP_CHAR;
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    // Chromium wraps new lines in <div> elements inside contenteditable
    if (node.tagName === "DIV" && node !== container) {
      if (node.previousSibling) text += "\n";
      for (const child of node.childNodes) {
        // Skip trailing <br> caret-placeholder that Chromium inserts
        if (
          child instanceof HTMLElement &&
          child.tagName === "BR" &&
          !child.nextSibling
        ) {
          continue;
        }
        walk(child);
      }
      return;
    }

    for (const child of node.childNodes) walk(child);
  }

  for (const child of container.childNodes) walk(child);
  return text;
}

/** Walk the contenteditable DOM and produce full text (chips → their fullText). */
function getFullTextFromDom(
  container: HTMLElement,
  items: Map<string, SiteContextItem>,
): string {
  let text = "";

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;

    const ctxId = node.dataset.siteContextId;
    if (ctxId) {
      const item = items.get(ctxId);
      if (item) text += item.fullText;
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    if (node.tagName === "DIV" && node !== container) {
      if (node.previousSibling) text += "\n";
      for (const child of node.childNodes) {
        if (
          child instanceof HTMLElement &&
          child.tagName === "BR" &&
          !child.nextSibling
        ) {
          continue;
        }
        walk(child);
      }
      return;
    }

    for (const child of node.childNodes) walk(child);
  }

  for (const child of container.childNodes) walk(child);
  return text;
}

/** Get cursor position in plain-text coordinates. */
function getCursorPositionInDom(container: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;

  const range = sel.getRangeAt(0);
  // Create a range from the start of the container to the cursor
  const preRange = document.createRange();
  preRange.setStart(container, 0);
  preRange.setEnd(range.startContainer, range.startOffset);

  const fragment = preRange.cloneContents();
  let pos = 0;

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      pos += (node.textContent || "").length;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.siteContextId) {
      pos += 1;
      return;
    }
    if (node.tagName === "BR") {
      pos += 1;
      return;
    }
    if (node.tagName === "DIV") {
      // Count the newline that a <div> block represents
      if (node.previousSibling) pos += 1;
      for (const child of node.childNodes) walk(child);
      return;
    }
    for (const child of node.childNodes) walk(child);
  }

  for (const child of fragment.childNodes) walk(child);
  return pos;
}

/** Convert a plain-text position to a {node, offset} in the DOM. */
function plainTextToDomPosition(
  container: HTMLElement,
  targetPos: number,
): { node: Node; offset: number } | null {
  let pos = 0;

  function walk(parent: Node): { node: Node; offset: number } | null {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i];

      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node.textContent || "").length;
        if (pos + len >= targetPos) {
          return { node, offset: targetPos - pos };
        }
        pos += len;
        continue;
      }

      if (!(node instanceof HTMLElement)) continue;

      if (node.dataset.siteContextId) {
        if (pos + 1 > targetPos) return { node: parent, offset: i };
        if (pos + 1 === targetPos) return { node: parent, offset: i + 1 };
        pos += 1;
        continue;
      }

      if (node.tagName === "BR") {
        if (pos + 1 > targetPos) return { node: parent, offset: i };
        pos += 1;
        continue;
      }

      if (node.tagName === "DIV") {
        if (node.previousSibling) {
          if (pos + 1 > targetPos) return { node: parent, offset: i };
          pos += 1;
        }
        const result = walk(node);
        if (result) return result;
        continue;
      }

      const result = walk(node);
      if (result) return result;
    }
    return null;
  }

  if (targetPos === 0) {
    const first = container.childNodes[0];
    if (first?.nodeType === Node.TEXT_NODE) return { node: first, offset: 0 };
    return { node: container, offset: 0 };
  }

  return (
    walk(container) ?? { node: container, offset: container.childNodes.length }
  );
}

/** Create a chip DOM element for a site context item. */
function createChipElement(item: SiteContextItem): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.siteContextId = item.id;
  chip.dataset.chip = "true";
  chip.className = [
    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
    "text-xs font-medium cursor-pointer select-none",
    "border align-baseline mx-0.5 whitespace-nowrap",
    "site-context-chip",
  ].join(" ");

  const icon = document.createElement("span");
  icon.className = "shrink-0 opacity-60";
  icon.textContent = "⟨⟩";
  chip.appendChild(icon);

  const label = document.createElement("span");
  label.className = "max-w-[140px] truncate";
  label.textContent = getSiteContextLabel(item);
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.className =
    "ml-0.5 rounded-sm cursor-pointer px-0.5 leading-none chip-close-btn";
  closeBtn.textContent = "×";
  closeBtn.dataset.chipClose = "true";
  chip.appendChild(closeBtn);

  return chip;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RichTextareaRef {
  getPlainText: () => string;
  getFullText: () => string;
  getCursorPosition: () => number;
  clear: () => void;
  focus: () => void;
  /** Replace a range in plain-text coordinates with new text. */
  replaceRange: (start: number, end: number, text: string) => void;
}

export interface RichTextareaProps {
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onChange?: (plainText: string, cursorPosition: number) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onKeyUp?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export const RichTextarea = forwardRef<RichTextareaRef, RichTextareaProps>(
  (
    {
      placeholder = "What would you like to know?",
      disabled = false,
      className,
      onChange,
      onKeyDown,
      onKeyUp,
      onClick,
      onFocus,
      onBlur,
    },
    ref,
  ) => {
    const editableRef = useRef<HTMLDivElement>(null);
    const itemsRef = useRef<Map<string, SiteContextItem>>(new Map());
    const isComposingRef = useRef(false);
    const [isEmpty, setIsEmpty] = useState(true);
    const [activeChip, setActiveChip] = useState<{
      item: SiteContextItem;
      rect: DOMRect;
    } | null>(null);

    /** Read plain text from the DOM and notify the parent. */
    const syncState = useCallback(() => {
      const el = editableRef.current;
      if (!el) return;
      const plainText = getPlainTextFromDom(el);
      const cursorPos = getCursorPositionInDom(el);
      const empty = plainText === "" || plainText === "\n";
      setIsEmpty(empty);
      onChange?.(plainText, cursorPos);
    }, [onChange]);

    // -- input event (typing / deletion / browser-level changes) -------------
    const handleInput = useCallback(() => {
      const el = editableRef.current;
      if (!el) return;

      // Prune items whose chip elements were removed from the DOM
      const idsInDom = new Set<string>();
      el.querySelectorAll("[data-site-context-id]").forEach((chip) => {
        const id = (chip as HTMLElement).dataset.siteContextId;
        if (id) idsInDom.add(id);
      });
      for (const id of itemsRef.current.keys()) {
        if (!idsInDom.has(id)) itemsRef.current.delete(id);
      }

      syncState();
    }, [syncState]);

    // -- keyboard -----------------------------------------------------------
    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (isComposingRef.current || e.nativeEvent.isComposing) return;

        // Enter without Shift → submit form
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const form = editableRef.current?.closest("form");
          const submitBtn = form?.querySelector(
            'button[type="submit"]',
          ) as HTMLButtonElement | null;
          if (submitBtn?.disabled) return;
          form?.requestSubmit();
        }
      },
      [onKeyDown],
    );

    const handleKeyUp = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        onKeyUp?.(e);
      },
      [onKeyUp],
    );

    // -- paste --------------------------------------------------------------
    const handlePaste = useCallback(
      (e: ReactClipboardEvent<HTMLDivElement>) => {
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;

        if (text.includes("[site_context]")) {
          e.preventDefault();
          const { remaining, items } = extractSiteContextBlocks(text);

          for (const item of items) {
            itemsRef.current.set(item.id, item);
          }

          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return;
          const range = sel.getRangeAt(0);
          range.deleteContents();

          const fragment = document.createDocumentFragment();
          for (const item of items) {
            fragment.appendChild(createChipElement(item));
            fragment.appendChild(document.createTextNode(" "));
          }
          if (remaining) {
            fragment.appendChild(document.createTextNode(remaining));
          }

          range.insertNode(fragment);

          // Collapse cursor to end of inserted content
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);

          syncState();
        } else {
          // Regular paste: insert as plain text to strip formatting
          e.preventDefault();
          document.execCommand("insertText", false, text);
        }
      },
      [syncState],
    );

    // -- clicks on chips / close buttons ------------------------------------
    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        onClick?.();

        const target = e.target as HTMLElement;

        // Close button
        if (target.dataset.chipClose) {
          e.preventDefault();
          e.stopPropagation();
          const chip = target.closest(
            "[data-site-context-id]",
          ) as HTMLElement | null;
          if (chip) {
            const id = chip.dataset.siteContextId;
            if (id) itemsRef.current.delete(id);
            chip.remove();
            syncState();
          }
          setActiveChip(null);
          return;
        }

        // Chip body → show detail popover
        const chip = target.closest(
          "[data-site-context-id]",
        ) as HTMLElement | null;
        if (chip) {
          const id = chip.dataset.siteContextId;
          if (id) {
            const item = itemsRef.current.get(id);
            if (item) {
              setActiveChip({ item, rect: chip.getBoundingClientRect() });
              return;
            }
          }
        }

        setActiveChip(null);
      },
      [onClick, syncState],
    );

    // -- imperative handle ---------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        getPlainText: () => {
          const el = editableRef.current;
          return el ? getPlainTextFromDom(el) : "";
        },
        getFullText: () => {
          const el = editableRef.current;
          return el ? getFullTextFromDom(el, itemsRef.current) : "";
        },
        getCursorPosition: () => {
          const el = editableRef.current;
          return el ? getCursorPositionInDom(el) : 0;
        },
        clear: () => {
          const el = editableRef.current;
          if (!el) return;
          el.innerHTML = "";
          itemsRef.current.clear();
          setIsEmpty(true);
          setActiveChip(null);
        },
        focus: () => {
          editableRef.current?.focus();
        },
        replaceRange: (start: number, end: number, text: string) => {
          const el = editableRef.current;
          if (!el) return;

          const startPos = plainTextToDomPosition(el, start);
          const endPos = plainTextToDomPosition(el, end);
          if (!startPos || !endPos) return;

          const range = document.createRange();
          range.setStart(startPos.node, startPos.offset);
          range.setEnd(endPos.node, endPos.offset);
          range.deleteContents();

          const textNode = document.createTextNode(text);
          range.insertNode(textNode);

          const sel = window.getSelection();
          if (sel) {
            const newRange = document.createRange();
            newRange.setStartAfter(textNode);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
          }

          syncState();
        },
      }),
      [syncState],
    );

    // -- close popover on outside click -------------------------------------
    useEffect(() => {
      if (!activeChip) return;
      const onMouseDown = (e: MouseEvent) => {
        const t = e.target as HTMLElement;
        if (
          !t.closest("[data-chip-popover]") &&
          !t.closest("[data-site-context-id]")
        ) {
          setActiveChip(null);
        }
      };
      document.addEventListener("mousedown", onMouseDown);
      return () => document.removeEventListener("mousedown", onMouseDown);
    }, [activeChip]);

    return (
      <>
        <div className="relative flex-1 w-full">
          <div
            ref={editableRef}
            contentEditable={!disabled}
            role="textbox"
            aria-multiline="true"
            aria-placeholder={placeholder}
            aria-disabled={disabled}
            suppressContentEditableWarning
            data-slot="input-group-control"
            className={cn(
              "w-full flex-1 resize-none rounded-none border-0 bg-transparent px-3 py-3 shadow-none",
              "focus-visible:ring-0 focus:outline-none",
              "text-base md:text-sm",
              "min-h-16 max-h-48 overflow-y-auto",
              "whitespace-pre-wrap break-words",
              disabled && "cursor-not-allowed opacity-50",
              className,
            )}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onClick={handleClick}
            onFocus={onFocus}
            onBlur={onBlur}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onPaste={handlePaste}
          />
          {/* Placeholder overlay */}
          {isEmpty && !disabled && (
            <div
              className="pointer-events-none absolute inset-0 px-3 py-3 text-base text-muted-foreground md:text-sm"
              aria-hidden
            >
              {placeholder}
            </div>
          )}
        </div>

        {/* Chip detail popover */}
        {activeChip && (
          <div
            data-chip-popover
            className="fixed z-50 w-[420px] max-w-[90vw] rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
            style={{
              top: Math.max(8, activeChip.rect.top - 8),
              left: Math.max(
                8,
                Math.min(activeChip.rect.left, window.innerWidth - 440),
              ),
              transform: "translateY(-100%)",
            }}
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="font-mono text-xs text-muted-foreground">
                {activeChip.item.source}
              </span>
              <button
                type="button"
                className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setActiveChip(null)}
              >
                ×
              </button>
            </div>
            <pre className="max-h-64 overflow-auto p-3 text-xs leading-relaxed">
              <code>{activeChip.item.snippet}</code>
            </pre>
          </div>
        )}
      </>
    );
  },
);
RichTextarea.displayName = "RichTextarea";
