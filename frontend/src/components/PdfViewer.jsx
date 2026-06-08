/* eslint-disable react-hooks/immutability -- 本组件用 pdf.js 命令式渲染 canvas/文本层/高亮 overlay 到真实 DOM，不适用不可变性规则 */
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const MAX_OUTPUT_SCALE = 2;
const FALLBACK_WIDTH = 800;

// 用 pdf.js 把每页渲染到 canvas（保留全部格式），上叠一层透明文本层（提供选区），
// 再叠一层高亮 overlay。划线定位用「归一化矩形 + 页码」的几何坐标（而非字符 offset），
// 缩放/翻页/resize 都能精确还原 —— 这是 PDF 标注的标准做法，根治字符 offset 漂移。
export default function PdfViewer({ url, highlights = [], onSelect, onOpenHighlight, onHighlightTops, onClearSelection }) {
  const hostRef = useRef(null);
  const pagesRef = useRef([]); // [{ pageEl, hlLayer, width, height }]
  const [containerWidth, setContainerWidth] = useState(0);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const width = Math.floor(host.clientWidth || host.parentElement?.clientWidth || 0);
      setContainerWidth((prev) => (width > 0 && width !== prev ? width : prev));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // 渲染 PDF
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    pagesRef.current = [];

    (async () => {
      try {
        const data = await (await fetch(url)).arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const targetWidth = Math.max(1, containerWidth || host.clientWidth || FALLBACK_WIDTH);
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const baseViewport = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: targetWidth / baseViewport.width });
          const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);

          const pageEl = document.createElement('div');
          pageEl.className = 'pdf-page';
          pageEl.dataset.page = String(n);
          pageEl.style.cssText = `position:relative;width:${viewport.width}px;height:${viewport.height}px;margin:0 0 16px;box-shadow:0 1px 10px rgba(0,0,0,0.08);background:#fff;`;

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
          pageEl.appendChild(canvas);

          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';
          pageEl.appendChild(textLayerDiv);

          const hlLayer = document.createElement('div');
          hlLayer.className = 'pdf-hl-layer';
          hlLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
          pageEl.appendChild(hlLayer);

          host.appendChild(pageEl);

          const renderContext = {
            canvasContext: canvas.getContext('2d'),
            viewport,
            transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
          };
          await page.render(renderContext).promise;
          if (cancelled) return;
          const textContent = await page.getTextContent();
          await new TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport }).render();

          pagesRef.current.push({ pageEl, hlLayer, width: viewport.width, height: viewport.height });
        }
        if (!cancelled) setReady((t) => t + 1);
      } catch (e) {
        if (!cancelled) host.innerHTML = `<p style="color:#dc2626;font-size:13px;padding:1rem;">PDF 加载失败：${e?.message || e}</p>`;
      }
    })();

    return () => { cancelled = true; };
  }, [url, containerWidth]);

  // 渲染历史高亮（PDF 就绪 或 highlights 变化时重画）
  useEffect(() => {
    for (const p of pagesRef.current) p.hlLayer.innerHTML = '';
    const nextTops = {};
    const hostOffsetTop = hostRef.current?.offsetTop || 0;
    for (const hl of highlights) {
      const pos = hl.position;
      if (!pos || !Array.isArray(pos.rects)) continue;
      let firstTop = null;
      for (const r of pos.rects) {
        const pageNum = r.page || pos.page || 1;
        const p = pagesRef.current[pageNum - 1];
        if (!p) continue;
        const div = document.createElement('div');
        const bg = hl.pending ? 'rgba(250,204,21,0.6)' : 'rgba(250,204,21,0.4)';
        const pointer = hl.pending ? 'none' : 'auto';
        const cursor = hl.pending ? 'default' : 'pointer';
        div.style.cssText = `position:absolute;left:${r.x * p.width}px;top:${r.y * p.height}px;width:${r.w * p.width}px;height:${r.h * p.height}px;background:${bg};border-radius:2px;pointer-events:${pointer};cursor:${cursor};`;
        if (!hl.pending) {
          div.title = '点击查看这条划线问答';
          div.onclick = () => onOpenHighlight && onOpenHighlight(hl.id);
        }
        p.hlLayer.appendChild(div);
        if (firstTop === null) firstTop = hostOffsetTop + p.pageEl.offsetTop + r.y * p.height;
      }
      if (!hl.pending && firstTop !== null) nextTops[hl.id] = Math.max(0, Math.round(firstTop));
    }
    onHighlightTops && onHighlightTops(nextTops);
  }, [highlights, ready, onOpenHighlight, onHighlightTops]);

  // 选区 → 归一化矩形 + 页码 → 回调
  const handleMouseUp = (event) => {
    event.stopPropagation();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      onClearSelection && onClearSelection();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      onClearSelection && onClearSelection();
      return;
    }
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement
      : range.startContainer;
    const pageEl = startEl?.closest?.('.pdf-page');
    if (!pageEl) {
      onClearSelection && onClearSelection();
      return;
    }
    const pageForRect = (rect) => pagesRef.current.find((p) => {
      const pr = p.pageEl.getBoundingClientRect();
      const y = rect.top + Math.min(rect.height / 2, 4);
      return y >= pr.top && y <= pr.bottom;
    });
    const rects = [...range.getClientRects()]
      .map((r) => {
        const p = pageForRect(r);
        if (!p) return null;
        const pageRect = p.pageEl.getBoundingClientRect();
        const pw = pageRect.width;
        const ph = pageRect.height;
        return {
          page: parseInt(p.pageEl.dataset.page, 10) || 1,
          x: (r.left - pageRect.left) / pw,
          y: (r.top - pageRect.top) / ph,
          w: r.width / pw,
          h: r.height / ph,
        };
      })
      .filter(Boolean)
      .filter((r) => r.w > 0.001 && r.h > 0.001);
    if (!rects.length) {
      onClearSelection && onClearSelection();
      return;
    }
    const clientRect = range.getBoundingClientRect();
    sel.removeAllRanges();
    onSelect && onSelect({
      text,
      position: { page: rects[0].page, rects },
      clientRect: { top: clientRect.top, right: clientRect.right },
    });
  };

  return <div ref={hostRef} className="pdf-viewer w-full overflow-hidden" onMouseUp={handleMouseUp} />;
}
