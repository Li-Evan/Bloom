"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";

import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { clampView, FIT_VIEW, fitSize, type ImageView, type Point, type Size, zoomView } from "@/lib/learn/image-zoom";
import { cn } from "@/lib/utils";

const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
const elementSize = (element: HTMLElement): Size => ({ width: element.offsetWidth, height: element.offsetHeight });
const stop = (event: React.SyntheticEvent) => event.stopPropagation();

function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const t = useTranslations("common");
  const imageRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<ImageView>(FIT_VIEW);
  const [size, setSize] = useState<Size>();
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointer: Point; view: ImageView; moved: boolean } | null>(null);

  // React 的 onWheel 是 passive 的，拦不住浏览器默认的滚动和触控板捏合缩放页面
  const bindWheel = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const image = imageRef.current;
      if (!image) return;
      // 触控板捏合是 ctrlKey + 很小的 deltaY；Firefox 的鼠标滚轮按行计
      const deltaY = event.deltaY * (event.ctrlKey ? 5 : 1) * (event.deltaMode === 1 ? 16 : 1);
      const viewport = viewportSize();
      const anchor = { x: event.clientX - viewport.width / 2, y: event.clientY - viewport.height / 2 };
      setView((current) => clampView(zoomView(current, deltaY, anchor), elementSize(image), viewport));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLImageElement>) => {
    if (view.scale === 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, view, moved: false };
    setDragging(true);
  };

  const moveDrag = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || !dragging) return;
    drag.moved = true;
    const next = {
      scale: drag.view.scale,
      x: drag.view.x + event.clientX - drag.pointer.x,
      y: drag.view.y + event.clientY - drag.pointer.y,
    };
    setView(clampView(next, elementSize(event.currentTarget), viewportSize()));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* 查看器渲染在 portal 里，但 React 事件仍会冒泡回课文：不能触发选字提问和标记 */}
      <DialogContent
        aria-describedby={undefined}
        showClose={false}
        onClick={stop}
        onMouseDown={stop}
        onMouseUp={stop}
        onMouseMove={stop}
        onKeyDown={stop}
        className="inset-0 left-0 top-0 block h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">{alt || t("image")}</DialogTitle>
        <div
          ref={bindWheel}
          className="flex size-full items-center justify-center"
          onClick={(event) => {
            // 拖动松手时指针可能落在背景上，这时不算点背景
            if (event.target === event.currentTarget && !dragRef.current?.moved) onClose();
            dragRef.current = null;
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width && height) setSize(fitSize({ width, height }, viewportSize()));
            }}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            style={{ ...size, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            className={cn(
              "max-w-none select-none rounded-sm bg-white",
              // 图片还没加载完（不知道原始尺寸）时先别超出屏幕
              !size && "max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)]",
              view.scale > 1 && "touch-none",
              view.scale > 1 && (dragging ? "cursor-grabbing" : "cursor-grab")
            )}
          />
        </div>
        <DialogClose className="absolute right-4 top-4 rounded-md bg-ink-inverse/60 p-2 text-white transition-colors hover:bg-ink-inverse">
          <X className="size-5" />
          <span className="sr-only">{t("close")}</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

// 文档里的图片：点击放大，放大后滚轮缩放、拖动。链接里的图片保持点击跳转
export default function ZoomableImage({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [open, setOpen] = useState(false);
  const show = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        {...props}
        alt={alt}
        loading="lazy"
        decoding="async"
        // WeChat swaps images for a "not allowed" placeholder when it sees our domain.
        referrerPolicy="no-referrer"
        role="button"
        tabIndex={0}
        className="cursor-zoom-in [a_&]:cursor-pointer"
        onClick={show}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") show(event);
        }}
      />
      {open && typeof props.src === "string" && <ImageViewer src={props.src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
