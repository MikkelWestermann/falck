import { nanoid } from "nanoid";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface SiteContextItem {
  id: string;
  /** e.g. "components/Button.tsx:42" */
  source: string;
  language: string;
  snippet: string;
  /** The original [site_context] block exactly as pasted */
  fullText: string;
}

/**
 * Parse a single [site_context] block into its components.
 * Returns null if the text doesn't match the expected format:
 *
 *   [site_context] Source: {{file}}:{{line}}
 *
 *   ```{{language}}
 *   {{snippet}}
 *   ```
 */
export function parseSiteContext(
  text: string,
): Omit<SiteContextItem, "id"> | null {
  const match = text.match(
    /\[site_context\]\s*Source:\s*([^\n]+)\n\n```(\w*)\n([\s\S]*?)```/,
  );
  if (!match) return null;

  return {
    source: match[1].trim(),
    language: match[2] || "",
    snippet: match[3]?.trimEnd() || "",
    fullText: match[0],
  };
}

/**
 * Extract all [site_context] blocks from pasted text.
 * Returns the remaining text (blocks removed) and the extracted items.
 */
export function extractSiteContextBlocks(text: string): {
  remaining: string;
  items: SiteContextItem[];
} {
  const items: SiteContextItem[] = [];
  const pattern =
    /\[site_context\]\s*Source:\s*[^\n]+\n\n```\w*\n[\s\S]*?```/g;
  let remaining = text;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const parsed = parseSiteContext(match[0]);
    if (parsed) {
      items.push({ ...parsed, id: nanoid() });
    }
    remaining = remaining.replace(match[0], "");
  }

  return { remaining: remaining.trim(), items };
}

/**
 * Compact label for a context item, e.g. "Button.tsx:42".
 */
export function getSiteContextLabel(item: SiteContextItem): string {
  const parts = item.source.split("/");
  return parts[parts.length - 1] || item.source;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "context"; item: SiteContextItem };

/**
 * Split message text into segments for display: plain text and [site_context] blocks.
 */
export function parseMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const pattern =
    /\[site_context\]\s*Source:\s*[^\n]+\n\n```\w*\n[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }
    const parsed = parseSiteContext(match[0]);
    if (parsed) {
      segments.push({
        type: "context",
        item: { ...parsed, id: `display-${match.index}` },
      });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

/**
 * Hook to parse message text into segments (text + context blocks).
 */
export function useMessageSegments(text: string): MessageSegment[] {
  return useMemo(() => parseMessageSegments(text), [text]);
}

/**
 * Renders a single site context chip with popover for detail.
 * Use with useMessageSegments to compose message display.
 */
export function SiteContextChip({ item }: { item: SiteContextItem }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
            "text-xs font-medium cursor-pointer select-none",
            "border align-baseline mx-0.5 whitespace-nowrap",
            "bg-primary-foreground/15 text-primary-foreground",
            "border-primary-foreground/30 hover:bg-primary-foreground/25",
          )}
        >
          <span className="shrink-0 opacity-60">⟨⟩</span>
          <span className="max-w-[140px] truncate">
            {getSiteContextLabel(item)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[420px] max-w-[90vw] p-0"
        side="top"
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="font-mono text-xs text-muted-foreground">
            {item.source}
          </span>
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <pre className="max-h-64 overflow-auto p-3 text-xs leading-relaxed">
          <code>{item.snippet}</code>
        </pre>
      </PopoverContent>
    </Popover>
  );
}
