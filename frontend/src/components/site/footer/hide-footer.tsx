// 让当前页面不显示页脚：在页面（或路由段 layout）里渲染 <HideFooter /> 即可，不需要客户端状态。
// 它是一段随页面一起服务端渲染的样式，所以首屏就没有页脚、不会闪一下；离开该页面时这个元素随页面卸载，页脚恢复。
export default function HideFooter() {
  return <style>{"[data-site-footer]{display:none}"}</style>;
}
