# Bloom 网页剪藏插件

在任意网页上点一下插件按钮（或按 Alt+Shift+S），这一页就存进你的 Bloom 的「网页剪藏」，存好后直接打开。

插件只负责取页和交接。抽正文、建课、报错都在 Bloom 里完成（`/learn/clip`，后端 `POST /api/clippings`）。

存下来的正文和站内「网页原文」对齐：Bloom 后端先自己读一遍这个网址，读得到完整正文就用它，和「网页原文」导入的一模一样；读不到（403、要登录、靠脚本出正文、内网）或只读到开头（付费墙）时，才用插件交来的这一页。

## 它怎么工作

1. 点击时，插件在当前页执行 `capturePage`（`src/background.js`），取下浏览器渲染好的整页 HTML。
   - 去掉样式和大段脚本，保留公式源码和数学渲染器的设置。
   - 页面用 MathJax 3 时，把每个公式的 TeX 写到 `data-bloom-tex` 上。取完就从页面上擦掉，原页面不变。
   - 飞书 / Lark 文档只把屏幕附近的块放在页面里：插件从头滚到尾，按 `data-record-id` 收齐每个顶层块，按块在屏幕上的前后邻居排好顺序，再滚回原处（最多滚 45 秒），拼回页面副本。后端 `web_import.feishu_article` 按块类型直接写成 Markdown。图片是只在飞书里能打开的 `blob:` 地址，存不下来。
2. 整页暂存在 `chrome.storage.session`：只在内存里，浏览器关掉就清空，最多同时留 2 页。然后插件打开 `<你的 Bloom 地址>/learn/clip?clip=<id>`。
3. Bloom 页面通过内容脚本 `src/bridge.js` 向插件要这一页，存好后通知插件删掉暂存。
4. 取不了的页面直接打开 `/learn/clip?error=<原因>`，由 Bloom 说明原因：浏览器自己的页面、PDF、超过 4 MB。
5. 每次点击都有回应：按钮上马上出现「…」，处理完消失。中途出任何错（取页超过 60 秒、暂存失败），都打开 `/learn/clip?error=failed`；在被点的标签页旁边开不出新标签页时（应用窗口、正在拖动标签页），就在别处开。

插件和页面之间的消息格式见 `frontend/src/lib/learn/clip-protocol.ts`。协议版本号和大小上限由 `build.mjs` 构建时从那里读进来，两边不会对不上。

## 权限

| 权限 | 用途 | 安装时的提示 |
|---|---|---|
| `activeTab` + `scripting` | 只在用户点击时读当前这一页 | 无 |
| `storage` | 把这一页暂存在内存里，等 Bloom 页面来取 | 无 |
| 你的 Bloom 地址上的内容脚本 | 把暂存的页面交给 `/learn/clip` | 「读取和更改您在 <地址> 上的数据」 |

插件不会读其他网站，也不会在后台读页面。

## 构建

插件在构建时写死你的 Bloom 地址（默认 `http://localhost:3000`）：

```bash
node extension/build.mjs
# 部署在别的地址时
BLOOM_ORIGIN=https://bloom.example.com node extension/build.mjs
```

产物在 `extension/dist/bloom-web-clipper-<地址>/`，同时生成同名 `.zip`。

## 本地安装

1. 打开 Chrome 的 `chrome://extensions`（Edge 是 `edge://extensions`），打开「开发者模式」。
2. 点「加载已解压的扩展程序」，选 `extension/dist/` 下刚构建出的文件夹。

消息格式变了时，`clip-protocol.ts` 里的 `CLIP_PROTOCOL` 加一。旧插件会收到「插件版本太旧」的提示。
