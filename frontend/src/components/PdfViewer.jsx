/* eslint-disable react-hooks/immutability -- 本组件用 pdf.js 命令式渲染 canvas/文本层/高亮 overlay 到真实 DOM，不适用不可变性规则 */
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const SCALE = 1.6;

// 用 pdf.js 把每页渲染到 canvas（保留全部格式），上叠一层透明文本层（提供选区），
// 再叠一层高亮 overlay。划线定位用「归一化矩形 + 页码」的几何坐标（而非字符 offset），
// 缩放/翻页/resize 都能精确还原 —— 这是 PDF 标注的标准做法，根治字符 offset 漂移。
export default function PdfViewer({ url, highlights = [], onSelect, onOpenHighlight }) {
  const hostRef = useRef(null);
  const pagesRef = useRef([]); // [{ pageEl, hlLayer, width, height }]
  const [ready, setReady] = useState(0);

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
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const viewport = page.getViewport({ scale: SCALE });

          const pageEl = document.createElement('div');
          pageEl.className = 'pdf-page';
          pageEl.dataset.page = String(n);
          pageEl.style.cssText = `position:relative;width:${viewport.width}px;height:${viewport.height}px;margin:0 auto 16px;box-shadow:0 1px 10px rgba(0,0,0,0.08);background:#fff;`;

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
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

          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
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
  }, [url]);

  // 渲染历史高亮（PDF 就绪 或 highlights 变化时重画）
  useEffect(() => {
    for (const p of pagesRef.current) p.hlLayer.innerHTML = '';
    for (const hl of highlights) {
      const pos = hl.position;
      if (!pos || !Array.isArray(pos.rects)) continue;
      const p = pagesRef.current[(pos.page || 1) - 1];
      if (!p) continue;
      for (const r of pos.rects) {
        const div = document.createElement('div');
        div.style.cssText = `position:absolute;left:${r.x * p.width}px;top:${r.y * p.height}px;width:${r.w * p.width}px;height:${r.h * p.height}px;background:rgba(250,204,21,0.4);border-radius:2px;pointer-events:auto;cursor:pointer;`;
        div.title = '点击查看这条划线问答';
        div.onclick = () => onOpenHighlight && onOpenHighlight(hl.id);
        p.hlLayer.appendChild(div);
      }
    }
  }, [highlights, ready, onOpenHighlight]);

  // 选区 → 归一化矩形 + 页码 → 回调
  const handleMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement
      : range.startContainer;
    const pageEl = startEl?.closest?.('.pdf-page');
    if (!pageEl) return;
    const pageNum = parseInt(pageEl.dataset.page, 10) || 1;
    const pageRect = pageEl.getBoundingClientRect();
    const pw = pageRect.width;
    const ph = pageRect.height;
    const rects = [...range.getClientRects()]
      .map((r) => ({
        x: (r.left - pageRect.left) / pw,
        y: (r.top - pageRect.top) / ph,
        w: r.width / pw,
        h: r.height / ph,
      }))
      .filter((r) => r.w > 0.001 && r.h > 0.001);
    if (!rects.length) return;
    const hostRect = hostRef.current.getBoundingClientRect();
    const anchorTop = Math.max(0, Math.round(range.getBoundingClientRect().top - hostRect.top));
    sel.removeAllRanges();
    onSelect && onSelect({ text, position: { page: pageNum, rects }, anchorTop });
  };

  return <div ref={hostRef} className="pdf-viewer" onMouseUp={handleMouseUp} />;
}
