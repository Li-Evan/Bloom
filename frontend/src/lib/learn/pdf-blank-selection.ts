import { SEGMENT_GAP, nearestTextBox } from "@/lib/learn/pdf-rects";

// 拖选 PDF 文字时，鼠标落到字外面的空白处（行尾右边、两行之间、页边），浏览器会把选区一下子拉到这一页的开头或末尾：
// 只想选一行，松手时过了行尾几个像素，就选上了后面整页。
// 做法照 pdf.js 自带阅读器（web/text_layer_builder.js）：每页文字层末尾放一个 .endOfContent（样式在 pdfjs-dist/web/pdf_viewer.css 里：
// 不可选；文字层带 .selecting 时铺满整页、垫在字下面），拖选时鼠标在空白处就落在它上面。
// Firefox 和 Chrome 148 起，鼠标在不可选的东西上时选区留在原地；更早的 Chrome 和 Safari 照样会跳，
// 所以把它挪到选区正在动的那一端旁边、改成可选，要跳也只跳到那一段字的头或尾。
// 和官方不同的一处：只在按着拖的时候铺开，松手就收起。官方在选区还在时一直铺着，那样点空白处收不掉选区（「提问」气泡关不掉）
//
// 上面管的是「从字上起拖、拖到空白处」。反过来从空白处起拖（页边、行与行之间、盖在字上的高亮），浏览器把选区的起点放在哪没法改：
// Chrome 148 起整次拖动什么都不选，更早的 Chrome、Safari、Firefox 从页首或页尾选起一大片。
// 这种拖动不交给浏览器：按下时自己定起点（鼠标所在那一行里最近的字，挑法见 pdf-rects.ts 的 nearestTextBox），
// 拖的时候用同样的挑法把选区的另一端跟着鼠标走。从字上起拖的照旧是浏览器自己的选区；
// 它拖到高亮上时高亮不接鼠标（learn.css 里跟着 .selecting 的那条），选区不断。
// 「在字上」按字框算，不按浏览器说鼠标落在哪段字上：它的命中范围是字体自带的上下高度，不看行高。字框高 11.7px 的一行，
// 中文界面下（sans-serif 落到苹方）每段字往上多出 3px，英文界面下（Helvetica）多出 2px，下一行的字就盖住上一行最下面那一截，
// 在那里按下去浏览器从下一行选起。没有用 overflow: clip 把命中范围裁回字框：每段字多一层裁剪，CPU 慢 4 倍时连续滚动掉的帧多两成
// layers：文字层 → 它的 .endOfContent，调用方在文字层搭好、放掉时增删
// autoscroll：自己管的拖动没有浏览器的自动滚动，每一帧拿鼠标的 y 问调用方要不要滚一点（鼠标贴到可见范围的上下边时）
export function guardBlankSelection(layers: Map<Element, HTMLElement>, autoscroll: (y: number) => void) {
  const listeners = new AbortController();
  const { signal } = listeners;
  const rest = (end: HTMLElement, layer: Element) => {
    if (end.nextSibling) layer.append(end);
    end.removeAttribute("style");
    layer.classList.remove("selecting");
  };
  let dragging = false;
  // 从空白处起拖时选区的起点；有它就是我们自己在管这次拖动
  let anchor: TextPoint | undefined;
  let mouse = false;
  const stop = () => {
    dragging = false;
    anchor = undefined;
    layers.forEach(rest);
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      mouse = event.pointerType === "mouse";
      // 右键不算：弹出系统菜单后不一定有松手事件，铺开的那层会留着
      if (event.button) return;
      dragging = true;
      const layer = (event.target as Element | null)?.closest?.(".textLayer");
      if (layer && layers.has(layer)) layer.classList.add("selecting");
    },
    { signal }
  );
  // 鼠标所在的那一页（在两页之间就是竖直方向最近的一页）上该从哪段字选起
  const textAt = (x: number, y: number) => {
    let layer: Element | undefined;
    let least = Infinity;
    for (const el of layers.keys()) {
      const { top, bottom } = el.getBoundingClientRect();
      const away = Math.max(top - y, 0, y - bottom);
      if (away < least) {
        layer = el;
        least = away;
      }
    }
    return layer && textPointAt(layer, x, y);
  };
  const pointer = { x: 0, y: 0 };
  // 按下后还没动出 DRAG_SLOP：点高亮、点空白处时手难免抖一两个像素，不能当成选了一个字
  let still = false;
  const extend = () => {
    const to = anchor && textAt(pointer.x, pointer.y);
    if (anchor && to) document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, to.node, to.offset);
  };
  const follow = () => {
    if (!anchor) return;
    if (!still) autoscroll(pointer.y);
    requestAnimationFrame(follow);
  };
  document.addEventListener(
    "mousedown",
    (event) => {
      // 双击、三击、按着 Shift 点的，Mac 上按着 Control 点（弹系统菜单）的，手指点出来的：照旧交给浏览器
      if (event.button || event.detail > 1 || event.shiftKey || event.ctrlKey || !mouse) return;
      const target = event.target as Element;
      const layer = target.closest?.(".pdf-page")?.querySelector(".textLayer");
      if (!layer || !layers.has(layer)) return;
      if (target.matches(TEXT)) {
        const { left, right, top, bottom } = target.getBoundingClientRect();
        if (event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom) return;
      }
      const from = textAt(event.clientX, event.clientY);
      if (!from) return;
      // 不让浏览器开始它自己的选区。它本来顺带做的两件事自己做：焦点从输入框里出来（不然 Cmd+C 复制的是输入框里的），
      // 原来的选区收起（只是点一下空白处的话，「提问」气泡要能关掉）
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      stop();
      anchor = from;
      document.getSelection()?.collapse(from.node, from.offset);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      still = true;
      requestAnimationFrame(follow);
    },
    { signal }
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!anchor) return;
      // 松手那一下没收到（弹出了系统菜单之类）：不能让选区跟着没按下的鼠标跑
      if (!(event.buttons & 1)) return stop();
      if (still && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < DRAG_SLOP) return;
      still = false;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      extend();
    },
    { signal }
  );
  // 鼠标没动、页面滚了（上面的自动滚动，或者按着拖的时候滚滚轮）：鼠标下面换了字
  document.addEventListener("scroll", extend, { capture: true, signal });
  document.addEventListener("pointerup", stop, { signal });
  document.addEventListener("pointercancel", stop, { signal });
  window.addEventListener("blur", stop, { signal });

  // 鼠标在不可选的东西上时选区是否留在原地
  let staysPut: boolean | undefined;
  let previous: Range | undefined;
  document.addEventListener(
    "selectionchange",
    () => {
      if (!dragging) return;
      const selection = document.getSelection();
      if (!selection?.rangeCount) {
        layers.forEach(rest);
        return;
      }
      // 选区拖到哪几页，哪几页铺开（Firefox 跨页选时一个选区有好几段）
      for (const [layer, end] of layers) {
        let touched = false;
        for (let i = 0; i < selection.rangeCount && !touched; i++) touched = selection.getRangeAt(i).intersectsNode(layer);
        if (touched) layer.classList.add("selecting");
        else rest(end, layer);
      }
      const first = layers.values().next().value;
      if (!first) return;
      staysPut ??=
        getComputedStyle(first).getPropertyValue("-moz-user-select") === "none" ||
        Number(/\bChrome\/(\d+)/.exec(navigator.userAgent)?.[1]) >= 148;
      if (staysPut) return;

      const range = selection.getRangeAt(0);
      // 这次动的是选区的开头还是结尾：结尾没变就是开头在动
      const movingStart =
        !!previous &&
        (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
      let node: Node | null = movingStart ? range.startContainer : range.endContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      if (!movingStart && range.endOffset === 0) {
        // 结尾落在某个节点的最前面：往前找到最近一段有字的
        do {
          while (node && !node.previousSibling) node = node.parentNode;
          node = node?.previousSibling ?? null;
        } while (node && !node.childNodes.length);
      }
      const layer = node?.parentElement?.closest(".textLayer");
      const end = layer && layers.get(layer);
      if (node && layer && end) {
        end.style.width = (layer as HTMLElement).style.width;
        end.style.height = (layer as HTMLElement).style.height;
        end.style.userSelect = "text";
        node.parentElement!.insertBefore(end, movingStart ? node : node.nextSibling);
      }
      previous = range.cloneRange();
    },
    { signal }
  );

  return () => listeners.abort();
}

// 文字层里有字的 span（.markedContent 是套在外面的壳）
const TEXT = ".textLayer span:not(.markedContent)";
const DRAG_SLOP = 4;

interface TextPoint {
  node: Text;
  offset: number;
}

// 这一页上该从哪段字选起（挑法见 nearestTextBox），和 x 落在它的第几个字前面（在这段字的左边是 0，右边是末尾）。
// 字的位置自己量，不用 caretPositionFromPoint：鼠标下面可能盖着高亮，各个浏览器对空白处的答案也不一样
function textPointAt(layer: Element, x: number, y: number): TextPoint | undefined {
  const boxes = [...layer.querySelectorAll<HTMLElement>(TEXT)].flatMap((span) => {
    const node = span.firstChild;
    // 空白不算；竖排、斜排的字也不算（按 x 找不出是第几个字）
    if (!(node instanceof Text) || !node.data.trim() || span.style.getPropertyValue("--rotate")) return [];
    const { left, right, top, bottom } = span.getBoundingClientRect();
    return [{ node, x0: left, x1: right, y0: top, y1: bottom }];
  });
  const node = nearestTextBox(boxes, layer.getBoundingClientRect().width * SEGMENT_GAP, x, y)?.node;
  if (!node) return;
  // 二分找第一个中线在 x 右边的字
  const range = document.createRange();
  let low = 0;
  let high = node.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    range.setStart(node, middle);
    range.setEnd(node, middle + 1);
    const { left, right } = range.getBoundingClientRect();
    if ((left + right) / 2 < x) low = middle + 1;
    else high = middle;
  }
  return { node, offset: low };
}
