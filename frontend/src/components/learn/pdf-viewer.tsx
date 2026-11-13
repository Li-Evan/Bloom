"use client";

import "pdfjs-dist/web/pdf_viewer.css";

// 用 pdf.js 的 legacy 构建（库和 worker 都是）：默认构建只管最新版浏览器，直接用了 Math.sumPrecise 这类很新的函数
// （Chrome 147、Safari 26.2 才有），旧一点的浏览器里内嵌字体转换会失败，正文退成系统字体、数学符号丢掉。
// legacy 构建自带这些函数的补丁，官方支持到 Chrome 125、Safari 18
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { useLearnError } from "@/components/learn/use-learn-error";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getLessonFile } from "@/lib/learn/api";
import type { Box } from "@/lib/learn/bubble";
import { guardBlankSelection } from "@/lib/learn/pdf-blank-selection";
import { normalizePdfRects, pdfTextLines, snapPdfRects, type PdfTextLine } from "@/lib/learn/pdf-rects";
import { contextAround } from "@/lib/learn/translation-context";
import type { PdfPosition } from "@/lib/learn/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// pdf.js 按需去取的字体和解码文件（scripts/copy-pdfjs-assets.mjs 在 dev / build 前拷到 public/pdfjs/<版本号>/）。
// 不告诉它地址：中文预定义编码（GBK-EUC-H 等）的 PDF 整页没字，JPEG 2000、JBIG2、CCITT 的扫描图片画不出来，
// Symbol、ZapfDingbats 和系统里找不到的标准字体没有替代。地址末尾要带 /
const PDFJS_ASSETS = `/pdfjs/${pdfjsLib.version}/`;
const PDFJS_ASSET_URLS = {
  cMapUrl: `${PDFJS_ASSETS}cmaps/`,
  standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
  wasmUrl: `${PDFJS_ASSETS}wasm/`,
  iccUrl: `${PDFJS_ASSETS}iccs/`,
};

// 单张画布最多这么多像素：放得再大也不再加清晰度。手机内存小，上限更低（和 pdf.js 自带阅读器在手机上的取值一样）
const MAX_CANVAS_PIXELS = 2 ** 24;
const MAX_CANVAS_PIXELS_TOUCH = 5242880;
const FALLBACK_WIDTH = 800;
// 只画看得见的页和它上下各这么多页；离得更远的页放掉画布（几百页的 PDF 全画出来，手机内存撑不住）
const RENDER_AROUND = 2;
// 宽度变化（拖窗口、开关参考原文面板）停下来这么久再按新宽度重排；放大缩小停下来这么久再按新清晰度重画画布
const RESIZE_DEBOUNCE_MS = 200;
// 缩放按钮的档位，1 = 适应宽度。到 2 倍时整页画布在桌面像素上限内还能按 Retina 的 2 倍画，再大就开始糊
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// 连点缩放时停下来这么久再重画画布：每点一下都重画好几页，连点就会卡
const ZOOM_REPAINT_MS = 150;
// 从空白处起拖选字时（lib/learn/pdf-blank-selection.ts），鼠标离可见范围的上下边不到这么远就自动滚：
// 越贴边越快，贴到边上一帧 10px，拖出边外一帧最多这么多
const AUTOSCROLL_EDGE = 40;
const AUTOSCROLL_MAX = 30;

// 竖直方向滚动的是哪个容器：课文页是整个窗口，参考原文面板是面板自己
const scrollerOf = (el: HTMLElement) => {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
};

// 竖直方向直接跳一段距离、不要平滑动画。不给 scrollBy 传 "instant" 这个滚动方式：老一些的 Safari 不认这个值，会直接抛错，
// 缩放做到一半就停住；临时把滚动容器的 scroll-behavior 设成 auto 再改 scrollTop，所有浏览器都一样
const jumpBy = (scroller: HTMLElement | null, dy: number) => {
  const target = scroller ?? document.scrollingElement;
  if (!(target instanceof HTMLElement)) return;
  const previous = target.style.scrollBehavior;
  target.style.scrollBehavior = "auto";
  target.scrollTop += dy;
  target.style.scrollBehavior = previous;
};

export interface PdfHighlight {
  id: number | string;
  position: PdfPosition;
  pending?: boolean;
  // 问答卡片开着的那条：画得比平时更深
  active?: boolean;
  // 划线翻译：只画虚线下划线，和问答、标记的淡绿底分开
  translation?: boolean;
}

interface PdfPage {
  page: PDFPageProxy;
  viewport: PageViewport;
  pageEl: HTMLDivElement;
  textLayerDiv: HTMLDivElement;
  hlLayer: HTMLDivElement;
  width: number;
  height: number;
  // 画布和文字层：只在页面靠近视口时才有
  canvas?: HTMLCanvasElement;
  task?: RenderTask;
  textLayer?: TextLayer;
  // 放大缩小后在后台按新尺寸重画的任务
  sharpening?: RenderTask;
  // 这一页每行有字的范围：第一次画这页时算，高亮框按它收到字上（画布放掉了也留着）
  lines?: PdfTextLine[];
}

const isCancelled = (e: unknown) => e instanceof pdfjsLib.RenderingCancelledException || (e as Error)?.name === "AbortException";

// 一页的全部文字。不用 page.getTextContent()：pdf.js 6.4 里它用 for await 读流，Safari 27 之前（iOS / macOS 26 及更早）没有这个写法，
// 一调就抛错，整篇报「没能加载」、没有文字层、选不了字。这里用 reader 一块块读，所有浏览器都有（pdf.js 6.5 也改回了这样）
type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
const readText = async (page: PDFPageProxy) => {
  const reader = page.streamTextContent().getReader();
  const content: TextContent = { items: [], styles: Object.create(null), lang: null };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return content;
    content.lang ??= value.lang;
    Object.assign(content.styles, value.styles);
    content.items.push(...value.items);
  }
};

// 用 pdf.js 把页面渲染到 canvas（保留全部格式），上叠一层透明文本层（提供选区），再叠一层高亮 overlay。
// 划线定位用「归一化矩形 + 页码」的几何坐标（而非字符 offset），缩放/翻页/resize 都能精确还原 —— 这是 PDF 标注的标准做法，根治字符 offset 漂移。
// 懒渲染：文档只下载、解析一次；每页先按 viewport 尺寸放一个固定大小的占位（高亮层也在占位里，位置只看 viewport，不管画没画），
// 进入视口的页和上下各 RENDER_AROUND 页才画 canvas 和文字层，远离的页把画布释放掉。
export default function PdfViewer({
  courseId,
  lessonNum,
  loadFile,
  highlights = [],
  onSelect,
  onOpenHighlight,
  onHighlightTops,
  onClearSelection,
}: {
  courseId: string;
  lessonNum: string;
  // 不走默认的课文文件接口取文件时传（例如测试页）：courseId、lessonNum 这时只用来判断要不要重新加载
  loadFile?: (signal: AbortSignal) => Promise<ArrayBuffer>;
  highlights?: PdfHighlight[];
  onSelect?: (selection: {
    text: string;
    position: PdfPosition;
    // 整个选区的外框、第一行和最后一行（视口坐标）：「提问」气泡紧挨着选区放（lib/learn/bubble.ts）
    box: Box;
    head: Box;
    tail: Box;
    // 选区所在这一页、以选区为中心的一段文字：划线翻译带给模型，按语境翻
    context: string;
  }) => void;
  onOpenHighlight?: (id: number | string) => void;
  onHighlightTops?: (tops: Record<string, number>) => void;
  onClearSelection?: () => void;
}) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;
  const [loadError, setLoadError] = useState("");
  // 「重试」：重新下载、解析
  const [attempt, setAttempt] = useState(0);
  // 每页的占位都放好了：在那之前（下载、解析中）显示一张空白页和转圈
  const [placed, setPlaced] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<PdfPage[]>([]);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [ready, setReady] = useState(0);
  // 又有页算好了行：高亮按新算出的行重画
  const [linesReady, setLinesReady] = useState(0);
  // 缩放按钮选的倍数（1 = 适应宽度）：换倍数时原地改每页尺寸，不拆掉重建
  const [pageZoom, setPageZoom] = useState(1);
  const pageZoomRef = useRef(pageZoom);
  pageZoomRef.current = pageZoom;
  const rezoomRef = useRef<((zoom: number) => void) | null>(null);
  // 点高亮的回调放进 ref：调用方每次渲染传一个新函数，不能因此把整层高亮拆了重画
  const openHighlightRef = useRef(onOpenHighlight);
  openHighlightRef.current = onOpenHighlight;

  // 量宽度：第一次量到立刻用，之后的变化等停下来 RESIZE_DEBOUNCE_MS 再用
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let applied = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const measure = () => {
      const width = Math.floor(
        host.clientWidth || host.parentElement?.clientWidth || 0
      );
      clearTimeout(timer);
      // 放大时外框变宽是自己撑出来的（--pdf-extra），不当成容器变宽：不然会按新宽度重新适应、再放大一圈
      if (pageZoomRef.current !== 1) return;
      if (width <= 0 || width === applied) return;
      const apply = () => {
        applied = width;
        setContainerWidth(width);
      };
      if (applied) timer = setTimeout(apply, RESIZE_DEBOUNCE_MS);
      else apply();
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // 下载、解析文档：每篇课文只做一次，宽度变了也不重下
  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    const download = new AbortController();
    setDoc(null);
    setLoadError("");
    setPlaced(false);

    (async () => {
      try {
        const data = await (loadFileRef.current?.(download.signal) ?? getLessonFile(courseId, lessonNum, download.signal));
        if (cancelled) return;
        // enableHWA：画布交给显卡画（pdf.js 自带的阅读器也是开着的）。默认关着时每一页都在主线程上一个像素一个像素地画，
        // 画完还要把整张位图传给显卡，放大后一张画布上千万像素，点一下、滚一下都跟着卡
        loadingTask = pdfjsLib.getDocument({ data, enableHWA: true, ...PDFJS_ASSET_URLS });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        setDoc(pdf);
      } catch (e) {
        if (!cancelled) setLoadError(report(e));
      }
    })();

    return () => {
      cancelled = true;
      // 中止还在进行的下载；终止加载中的任务、销毁已打开的文档并结束它的 worker
      download.abort();
      loadingTask
        ?.destroy()
        .catch((e) => console.error("pdf destroy failed", e));
    };
  }, [courseId, lessonNum, report, attempt]);

  // 按当前宽度给每页放占位，挂上「靠近视口才画」的监听
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !doc) return;
    const pdf = doc;
    let cancelled = false;
    host.innerHTML = "";
    pagesRef.current = [];
    const fitWidth = Math.max(1, containerWidth || host.clientWidth || FALLBACK_WIDTH);
    let pageWidth = fitWidth * pageZoomRef.current;
    const viewportOf = (page: PDFPageProxy) => page.getViewport({ scale: pageWidth / page.getViewport({ scale: 1 }).width });
    // 文字层的字号和宽高按 --total-scale-factor 算（pdf.js 只在它自己的 .pdfViewer .page 上设）。
    // 不设就退回页面默认字号，透明文字比画布上的字宽一截，划线取到的字和看到的对不上
    const fit = (pageEl: HTMLDivElement, viewport: PageViewport) => {
      pageEl.style.cssText = `width:${viewport.width}px;height:${viewport.height}px;--total-scale-factor:${viewport.scale};`;
    };
    // 画布清晰度 = 屏幕像素比 × 捏合放大的倍数（浏览器缩放改的是像素比）：放大以后字也是清楚的，不是把小图拉大
    const maxPixels = window.matchMedia("(pointer: coarse)").matches ? MAX_CANVAS_PIXELS_TOUCH : MAX_CANVAS_PIXELS;
    const pixelRatio = () => (window.devicePixelRatio || 1) * (window.visualViewport?.scale || 1);
    let ratio = pixelRatio();
    const scaleOf = (p: PdfPage) => Math.min(ratio, Math.sqrt(maxPixels / (p.width * p.height)));

    // 这页的画布现在该有多少像素宽：现有的画布不是这么宽，就是放大缩小之后还没重画
    const pixelWidth = (p: PdfPage) => Math.floor(p.width * scaleOf(p));

    const paint = (p: PdfPage) => {
      const scale = scaleOf(p);
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth(p);
      canvas.height = Math.floor(p.height * scale);
      const task = p.page.render({
        canvas,
        viewport: p.viewport,
        transform: scale === 1 ? undefined : [scale, 0, 0, scale, 0, 0],
      });
      return { canvas, task };
    };
    // 先把画布缩成 0×0 再拿掉：浏览器才会立刻放掉它占的显存
    const free = (canvas?: HTMLCanvasElement) => {
      if (!canvas) return;
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    };

    // 放大缩小时文字层是整层拉伸着顶上的（见缩放按钮那段）：这里按这页现在的尺寸重排，去掉拉伸
    const settle = (p: PdfPage) => {
      if (!p.textLayerDiv.style.scale) return;
      fit(p.pageEl, p.viewport);
      p.textLayerDiv.style.scale = "";
    };

    // 等着画的页：还没画过的，和放大缩小后要重画的
    const queue = new Set<PdfPage>();
    const visible = new Set<number>();
    // 每页文字层末尾的 .endOfContent：拖选时鼠标落到字外面的空白处，选区不往页首页尾跳（lib/learn/pdf-blank-selection.ts）
    const blanks = new Map<Element, HTMLElement>();
    const unguard = guardBlankSelection(blanks, (y) => {
      const scroller = scrollerOf(host);
      const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const past = Math.min(0, y - view.top - AUTOSCROLL_EDGE) || Math.max(0, y - view.bottom + AUTOSCROLL_EDGE);
      if (past) jumpBy(scroller, Math.max(-AUTOSCROLL_MAX, Math.min(AUTOSCROLL_MAX, past / 4)));
    });

    const release = (p: PdfPage) => {
      queue.delete(p);
      p.task?.cancel();
      p.sharpening?.cancel();
      p.textLayer?.cancel();
      free(p.canvas);
      p.textLayerDiv.replaceChildren();
      p.textLayerDiv.classList.remove("selecting");
      blanks.delete(p.textLayerDiv);
      p.canvas = undefined;
      p.task = undefined;
      p.sharpening = undefined;
      p.textLayer = undefined;
      settle(p);
    };

    // 已经画好的页按现在的尺寸和清晰度在后台重画一张，画好再换上（换的时候不闪白）
    const sharpen = async (p: PdfPage) => {
      if (!p.canvas || p.canvas.width === pixelWidth(p)) return;
      const { canvas, task } = paint(p);
      p.sharpening = task;
      try {
        await task.promise;
        if (cancelled || p.sharpening !== task) {
          free(canvas);
          return;
        }
        p.pageEl.prepend(canvas);
        free(p.canvas);
        p.canvas = canvas;
        p.sharpening = undefined;
      } catch (e) {
        free(canvas);
        if (!cancelled && !isCancelled(e)) setLoadError(report(e));
      }
    };

    // 文字层在页面外搭好再放回去：pdf.js 每放一段字就量一次字宽，放在页面里搭的话，
    // 每量一次浏览器都要先把刚放进去的那一段的样式算出来，一页上百段字就是上百次
    const write = async (p: PdfPage, task: RenderTask) => {
      try {
        const textContent = await readText(p.page);
        if (cancelled || p.task !== task) return;
        if (!p.lines) {
          p.lines = pdfTextLines(textContent.items, p.viewport);
          setLinesReady((n) => n + 1);
        }
        // 文字层和 pdf.js 量字宽用的画布标同一种语言。pdf.js 给那张画布标 PDF 自己写的语言（没写就标空），文字层不标的话跟着页面走（中文界面是 zh）：
        // 同样写 sans-serif，两种语言落到不同的字体上（Mac 上 zh 是苹方，空和 en 是 Helvetica），英文 PDF 的透明文字就比画布上的字宽 5% 多，
        // 一行拖到头少选好几个字。两边都明确标成同一种，不留空（空在画布上和在页面里的含义还不一样）
        const lang = textContent.lang || document.documentElement.lang || "en";
        p.textLayerDiv.lang = lang;
        const textLayer = new TextLayer({
          textContentSource: { ...textContent, lang },
          container: p.textLayerDiv,
          viewport: p.viewport,
        });
        p.textLayer = textLayer;
        p.textLayerDiv.remove();
        try {
          await textLayer.render();
        } finally {
          p.pageEl.insertBefore(p.textLayerDiv, p.hlLayer);
        }
        const end = document.createElement("div");
        end.className = "endOfContent";
        p.textLayerDiv.append(end);
        blanks.set(p.textLayerDiv, end);
      } catch (e) {
        // 页面滚远了、宽度变了、换了课文：做到一半被取消是正常的
        if (!cancelled && !isCancelled(e)) setLoadError(report(e));
      }
    };

    const draw = async (p: PdfPage) => {
      const { canvas, task } = paint(p);
      p.pageEl.prepend(canvas);
      p.canvas = canvas;
      p.task = task;
      try {
        await task.promise;
        if (cancelled || p.task !== task) return;
        void write(p, task);
      } catch (e) {
        if (!cancelled && !isCancelled(e)) setLoadError(report(e));
      }
    };

    // 画布一次只画一页，先画离屏幕上露出来的页最近的。pdf.js 每一帧给每个正在画的任务 15ms：
    // 几页一起画，一帧就是几十毫秒；排着队画，每帧最多 15ms，露出来的那页也最先清楚
    const away = (p: PdfPage) => {
      const i = p.page.pageNumber - 1;
      let distance = Infinity;
      for (const v of visible) distance = Math.min(distance, Math.abs(v - i));
      return distance;
    };
    // 等下一帧画完再接着做：换上新画布、重排一页文字层、开始画下一页各占一帧，不叠在同一帧里
    const breathe = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    let painting = false;
    const pump = async () => {
      if (painting) return;
      painting = true;
      while (queue.size && !cancelled) {
        const p = [...queue].reduce((a, b) => (away(b) < away(a) ? b : a));
        queue.delete(p);
        if (!p.canvas) await draw(p);
        else {
          await sharpen(p);
          await breathe();
          // 文字层这时才按新尺寸重排、重新量字宽：字是透明的，放大缩小的那一下用不上，当场做要多卡几十毫秒
          settle(p);
          p.textLayer?.update({ viewport: p.viewport });
        }
        await breathe();
      }
      painting = false;
    };
    // 画好的页都按现在的尺寸和清晰度重画一遍
    const repaint = () => {
      for (const p of pagesRef.current) if (p.canvas) queue.add(p);
      void pump();
    };

    const update = () => {
      if (!visible.size) return;
      const from = Math.min(...visible) - RENDER_AROUND;
      const to = Math.max(...visible) + RENDER_AROUND;
      pagesRef.current.forEach((p, i) => {
        if (i < from || i > to) {
          queue.delete(p);
          if (p.canvas) release(p);
        } else if (!p.canvas) queue.add(p);
      });
      void pump();
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page) - 1;
        if (entry.isIntersecting) visible.add(index);
        else visible.delete(index);
      }
      update();
    });

    // 浏览器缩放（Cmd +/-）、触控板或手指捏合放大：停下来以后已经画好的页按新清晰度重画；排版和文字层按 CSS 像素算，不用动
    let zoomTimer: ReturnType<typeof setTimeout> | undefined;
    const onZoom = () => {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => {
        const next = pixelRatio();
        if (next === ratio) return;
        ratio = next;
        repaint();
      }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", onZoom);
    window.visualViewport?.addEventListener("resize", onZoom);

    // 放大时外框跟着变宽：在整页容器上设 --pdf-extra（放大多出来的宽度），learn.css 据此放宽课文栏、右栏往右让；
    // 屏幕放不下时课文栏照样收窄，PDF 在框里横向滚动。参考原文面板（不在这个容器里）只在框里滚动
    // --pdf-extra 在 learn.css 里注册成不继承，所以用到它的整页容器和栅格各设一遍：按默认的继承，
    // 改一下整页每个元素（PDF 文字层的每一段字）的样式都要重算
    const frame = host.closest<HTMLElement>("[data-learn-page]");
    const frames = [frame, frame && host.closest<HTMLElement>("[data-learn-columns]")];
    const widen = (zoom: number) => {
      const extra = Math.max(0, Math.round(fitWidth * (zoom - 1)));
      for (const el of frames) {
        if (extra) el?.style.setProperty("--pdf-extra", `${extra}px`);
        else el?.style.removeProperty("--pdf-extra");
      }
    };
    widen(pageZoomRef.current);

    // 缩放按钮：原地改每页尺寸。缩放前 PDF 可见部分正中那一点，缩放后还停在屏幕上同一个位置；
    // 画好的页先拿旧画布拉伸着顶上，等连点停下来 ZOOM_REPAINT_MS 再按新尺寸一页页重画好换上、更新文字层
    let repaintTimer: ReturnType<typeof setTimeout> | undefined;
    rezoomRef.current = (zoom) => {
      const pages = pagesRef.current;
      const next = fitWidth * zoom;
      if (next === pageWidth || !pages.length) {
        pageWidth = next;
        widen(zoom);
        return;
      }
      const scroller = scrollerOf(host);
      const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const box = host.getBoundingClientRect();
      const x = (Math.max(box.left, 0) + Math.min(box.right, window.innerWidth)) / 2;
      const y = (Math.max(box.top, view.top) + Math.min(box.bottom, view.bottom)) / 2;
      const anchor = pages.find((p) => p.pageEl.getBoundingClientRect().bottom >= y) ?? pages[pages.length - 1];
      const before = anchor.pageEl.getBoundingClientRect();
      const fx = (x - before.left) / before.width;
      const fy = (y - before.top) / before.height;

      pageWidth = next;
      widen(zoom);
      for (const p of pages) {
        p.viewport = viewportOf(p.page);
        p.width = p.viewport.width;
        p.height = p.viewport.height;
        if (p.textLayer) {
          // 有文字层的页只改大小，文字层整层拉伸着顶上（字是透明的，位置照样对得上），轮到这页重画时再按新尺寸重排（settle）：
          // 当场改 --total-scale-factor，这页每一段字的样式都要重算，几页加起来点一下要多卡十几毫秒
          const laid = Number(p.pageEl.style.getPropertyValue("--total-scale-factor"));
          p.pageEl.style.width = `${p.width}px`;
          p.pageEl.style.height = `${p.height}px`;
          p.textLayerDiv.style.scale = String(p.viewport.scale / laid);
        } else fit(p.pageEl, p.viewport);
        // 还在按旧尺寸重画的、排着队等重画的都作废，停下来再说
        p.sharpening?.cancel();
        if (p.canvas) queue.delete(p);
      }
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(repaint, ZOOM_REPAINT_MS);

      const after = anchor.pageEl.getBoundingClientRect();
      host.scrollLeft += after.left + fx * after.width - x;
      jumpBy(scroller, after.top + fy * after.height - y);
      setReady((r) => r + 1);
    };

    const placeholder = (page: PDFPageProxy, n: number): PdfPage => {
      const viewport = viewportOf(page);
      const pageEl = document.createElement("div");
      pageEl.className = "pdf-page";
      pageEl.dataset.page = String(n);
      fit(pageEl, viewport);

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className = "textLayer";
      pageEl.appendChild(textLayerDiv);

      const hlLayer = document.createElement("div");
      hlLayer.className = "pdf-hl-layer";
      pageEl.appendChild(hlLayer);

      host.appendChild(pageEl);
      observer.observe(pageEl);

      return { page, viewport, pageEl, textLayerDiv, hlLayer, width: viewport.width, height: viewport.height };
    };

    (async () => {
      try {
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          pagesRef.current.push(placeholder(page, n));
        }
        setReady((r) => r + 1);
        setPlaced(true);
      } catch (e) {
        if (!cancelled) setLoadError(report(e));
      }
    })();

    return () => {
      cancelled = true;
      observer.disconnect();
      unguard();
      clearTimeout(zoomTimer);
      clearTimeout(repaintTimer);
      window.removeEventListener("resize", onZoom);
      window.visualViewport?.removeEventListener("resize", onZoom);
      rezoomRef.current = null;
      for (const el of frames) el?.style.removeProperty("--pdf-extra");
      queue.clear();
      pagesRef.current.forEach(release);
      pagesRef.current = [];
      host.innerHTML = "";
    };
  }, [doc, containerWidth, report]);

  useEffect(() => {
    // 缩放出了错也不能把整篇课文带崩：记下来，页面照常可用
    try {
      rezoomRef.current?.(pageZoom);
    } catch (e) {
      console.error("pdf zoom failed", e);
    }
  }, [pageZoom]);
  const zoomBy = (dir: 1 | -1) =>
    setPageZoom((z) => (dir > 0 ? ZOOM_STEPS.find((s) => s > z) : [...ZOOM_STEPS].reverse().find((s) => s < z)) ?? z);

  // 渲染历史高亮（占位放好 或 highlights 变化时重画）：位置只看每页 viewport 的尺寸和占位的位置，不等页面画出来
  useEffect(() => {
    for (const p of pagesRef.current) p.hlLayer.innerHTML = "";
    const nextTops: Record<string, number> = {};
    const hostOffsetTop = hostRef.current?.offsetTop || 0;
    for (const hl of highlights) {
      const pos = hl.position;
      if (!pos || !Array.isArray(pos.rects)) continue;
      let firstTop: number | null = null;
      const rects = snapPdfRects(
        pos.rects.map((r) => ({ ...r, page: r.page || pos.page || 1 })),
        (n) => pagesRef.current[n - 1]?.lines
      );
      for (const r of rects) {
        const p = pagesRef.current[r.page - 1];
        if (!p) continue;
        const div = document.createElement("div");
        div.className = "pdf-hl";
        if (hl.pending) div.dataset.pending = "";
        if (hl.active) div.dataset.active = "";
        if (hl.translation) div.dataset.translation = "";
        div.style.cssText = `left:${r.x * p.width}px;top:${r.y * p.height}px;width:${r.w * p.width}px;height:${r.h * p.height}px;`;
        if (!hl.pending) {
          div.title = t("pdf.openHighlight");
          // 从高亮上起拖选了字的不算点它
          div.onclick = () => window.getSelection()?.isCollapsed !== false && openHighlightRef.current?.(hl.id);
        }
        p.hlLayer.appendChild(div);
        if (firstTop === null)
          firstTop = hostOffsetTop + p.pageEl.offsetTop + r.y * p.height;
      }
      if (firstTop !== null) {
        nextTops[hl.id] = Math.max(0, Math.round(firstTop));
      }
    }
    onHighlightTops && onHighlightTops(nextTops);
  }, [highlights, ready, linesReady, onHighlightTops, t]);

  // 选区 → 归一化矩形 + 页码 → 回调
  const handleMouseUp = (event: React.MouseEvent) => {
    event.stopPropagation();
    // 参考原文（没有 onSelect）只供阅读和复制：不处理选区，更不能把它清掉
    if (!onSelect) return;
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
    const startEl =
      range.startContainer.nodeType === 3
        ? range.startContainer.parentElement
        : (range.startContainer as Element);
    const pageEl = startEl?.closest?.(".pdf-page");
    if (!pageEl) {
      onClearSelection && onClearSelection();
      return;
    }
    const pageForRect = (rect: DOMRect) =>
      pagesRef.current.find((p) => {
        const pr = p.pageEl.getBoundingClientRect();
        const y = rect.top + Math.min(rect.height / 2, 4);
        return y >= pr.top && y <= pr.bottom;
      });
    const rects = snapPdfRects(normalizePdfRects([...range.getClientRects()]
      .map((r) => {
        const p = pageForRect(r);
        if (!p) return null;
        const pageRect = p.pageEl.getBoundingClientRect();
        const pw = pageRect.width;
        const ph = pageRect.height;
        return {
          page: parseInt(p.pageEl.dataset.page || "1", 10) || 1,
          x: (r.left - pageRect.left) / pw,
          y: (r.top - pageRect.top) / ph,
          w: r.width / pw,
          h: r.height / ph,
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r)), (n) => pagesRef.current[n - 1]?.lines);
    if (!rects.length) {
      onClearSelection && onClearSelection();
      return;
    }
    const box = range.getBoundingClientRect();
    const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    // 文字层里最里面的那些 span 才是字（外层的 markedContent 也是 span，算上会重复）
    const pageText = [...pageEl.querySelectorAll(".textLayer span")].filter((el) => !el.querySelector("span")).map((el) => el.textContent).join(" ");
    // 同课文：鼠标选的字留着能复制，触屏上收掉选区，免得系统的选字菜单盖住气泡
    if (window.matchMedia("(pointer: coarse)").matches) sel.removeAllRanges();
    onSelect({
      text,
      position: { page: rects[0].page, rects },
      box,
      head: lines[0] ?? box,
      tail: lines[lines.length - 1] ?? box,
      context: contextAround(pageText, text),
    });
  };

  return (
    <>
      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-destructive">
          <span className="min-w-0 text-pretty">{t("pdf.loadFailed", { message: loadError })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        !placed && (
          // 下载、解析期间：一张 A4 比例的空白页 + 转圈，不是一片空白
          <div
            role="status"
            className="flex aspect-[210/297] w-full flex-col items-center justify-center gap-3 bg-muted/40 text-sm text-muted-foreground"
          >
            <Spinner className="size-6 text-primary-text" />
            {t("pdf.loading")}
          </div>
        )
      )}
      <div
        ref={hostRef}
        className="pdf-viewer w-full overflow-x-auto"
        onMouseUp={handleMouseUp}
      />
      {placed && !loadError && (
        // 缩放按钮：贴在 PDF 可见部分的右下角跟着滚，不占排版高度。
        // 点击不往外冒：外层课文的点击和松开鼠标另有用处（收起选区、打开笔记）
        <div className="pointer-events-none sticky bottom-4 z-10 h-0">
          <div
            role="group"
            aria-label={t("pdf.zoom")}
            className="pointer-events-auto absolute bottom-0 right-3 flex items-center gap-0.5 rounded-full border bg-card/95 p-1 text-card-foreground shadow-md backdrop-blur"
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              aria-label={t("pdf.zoomOut")}
              title={t("pdf.zoomOut")}
              disabled={pageZoom <= ZOOM_STEPS[0]}
              onClick={() => zoomBy(-1)}
            >
              <Minus />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 min-w-14 rounded-full px-2 tabular-nums"
              title={t("pdf.zoomReset")}
              aria-label={`${t("pdf.zoomReset")} (${Math.round(pageZoom * 100)}%)`}
              onClick={() => setPageZoom(1)}
            >
              {Math.round(pageZoom * 100)}%
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              aria-label={t("pdf.zoomIn")}
              title={t("pdf.zoomIn")}
              disabled={pageZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              onClick={() => zoomBy(1)}
            >
              <Plus />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
