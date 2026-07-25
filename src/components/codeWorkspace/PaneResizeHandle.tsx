import { useEffect, useRef } from 'react';

/** Vertical drag handle between PocketCode columns. */
export default function PaneResizeHandle({
  onDrag,
  title = 'Drag to resize',
}: {
  onDrag: (deltaX: number) => void;
  title?: string;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastX.current;
      lastX.current = e.clientX;
      if (dx !== 0) onDrag(dx);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onDrag]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        lastX.current = e.clientX;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      className="hidden lg:flex w-1.5 shrink-0 cursor-col-resize items-stretch group relative z-20"
    >
      <div className="mx-auto w-px h-full bg-surface-200 dark:bg-surface-800 group-hover:bg-primary-500/70 group-active:bg-primary-500 transition-colors" />
    </div>
  );
}
