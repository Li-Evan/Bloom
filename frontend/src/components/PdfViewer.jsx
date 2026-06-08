import { useEffect, useRef, forwardRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

// 用 pdf.js 渲染 PDF：每页画到 canvas（保留全部格式），上面叠一层透明文本层（可选区）。
// forwardRef 暴露的是文本层宿主容器 —— 把它挂到 LessonPage 的 proseRef，
// 现有「选区 → 提问 → 高亮」整套就直接作用在 PDF 文字上。
const PdfViewer = forwardRef(function PdfViewer({ url, onReady }, ref) {
  const hostRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';

    (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const viewport = page.getViewport({ scale: 1.6 });

          const pageEl = document.createElement('div');
          pageEl.className = 'pdf-page';
          pageEl.style.cssText = `position:relative;width:${viewport.width}px;height:${viewport.height}px;margin:0 auto 16px;box-shadow:0 1px 10px rgba(0,0,0,0.08);background:#fff;`;

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.cssText = 'display:block;width:100%;height:100%;';
          pageEl.appendChild(canvas);

          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';
          pageEl.appendChild(textLayerDiv);

          host.appendChild(pageEl);

          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          if (cancelled) return;
          const textContent = await page.getTextContent();
          const textLayer = new TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
          await textLayer.render();
        }
        if (!cancelled && onReady) onReady();
      } catch (e) {
        if (!cancelled) {
          host.innerHTML = `<p style="color:#dc2626;font-size:13px;padding:1rem;">PDF 加载失败：${e?.message || e}</p>`;
        }
      }
    })();

    return () => { cancelled = true; };
  }, [url, onReady]);

  return (
    <div
      ref={(el) => {
        hostRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      className="pdf-viewer"
    />
  );
});

export default PdfViewer;
