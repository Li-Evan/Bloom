export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ImageView = Point & { scale: number };

export const FIT_VIEW: ImageView = { scale: 1, x: 0, y: 0 };

const MAX_SCALE = 8;
const MAX_UPSCALE = 3;
const VIEWPORT_MARGIN = 32;

// 放大后先铺满屏幕，否则比课文栏窄的图点开和原来一样大；小图最多放大 3 倍，再大就全是马赛克
export function fitSize(natural: Size, viewport: Size): Size {
  const ratio = Math.min(
    (viewport.width - VIEWPORT_MARGIN) / natural.width,
    (viewport.height - VIEWPORT_MARGIN) / natural.height,
    MAX_UPSCALE
  );
  return { width: natural.width * ratio, height: natural.height * ratio };
}

// 图比屏幕大才能移动，而且不能移出边界；缩回原大小时自然回到正中
export function clampView(view: ImageView, image: Size, viewport: Size): ImageView {
  const clamp = (offset: number, length: number, room: number) => {
    const limit = Math.max(0, (length * view.scale - room) / 2);
    return Math.min(limit, Math.max(-limit, offset));
  };
  return {
    scale: view.scale,
    x: clamp(view.x, image.width, viewport.width),
    y: clamp(view.y, image.height, viewport.height),
  };
}

// 滚轮缩放：鼠标指着的那个点留在原地。anchor 是鼠标相对屏幕中心的位置
export function zoomView(view: ImageView, deltaY: number, anchor: Point): ImageView {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale * Math.exp(-deltaY * 0.002)));
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}
