import { useLayoutEffect, useRef } from 'react';

/** Default ~1 visible line — grows as the user types. */
const DEFAULT_MIN_PX = 40;
/** Cap height then scroll inside the box instead of clipping text off-screen. */
const DEFAULT_MAX_PX = 320;

/**
 * Keeps a textarea visible as the user types: grows with content up to maxHeightPx,
 * then scrolls internally. Reset height to `auto` first so deleting lines shrinks back.
 */
export function useAutoResizeTextarea(
  value: string,
  options?: { maxHeightPx?: number; minHeightPx?: number },
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const maxPx = options?.maxHeightPx ?? DEFAULT_MAX_PX;
  const minPx = options?.minHeightPx ?? DEFAULT_MIN_PX;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    const contentHeight = el.scrollHeight;
    const next = Math.max(minPx, Math.min(contentHeight, maxPx));
    el.style.height = `${next}px`;
    el.style.overflowY = contentHeight > maxPx ? 'auto' : 'hidden';
  }, [value, maxPx, minPx]);

  return ref;
}
