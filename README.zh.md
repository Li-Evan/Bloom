<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo.svg">
    <img alt="Bloom" src="assets/logo.svg" width="360">
  </picture>
</p>

<p align="center">
  <strong>给任何想学的东西，请一位私人 AI 导师。</strong>
</p>

<p align="center">
  <em>AI 读懂你真实的理解程度，再为你一个人定制下一篇课文。<br>源自 Bloom 的 2σ 研究：一对一辅导 = 冲进前 2%。</em>
</p>

<p align="center">
  <a href="https://github.com/Li-Evan/Bloom/stargazers"><img src="https://img.shields.io/github/stars/Li-Evan/Bloom?style=social" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/github/last-commit/Li-Evan/Bloom" alt="Last commit">
  <img src="https://img.shields.io/badge/python-3.11+-blue.svg" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/node-20+-blue.svg" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/next.js-15-blue.svg" alt="Next.js 15">
  <img src="https://img.shields.io/badge/fastapi-0.115+-blue.svg" alt="FastAPI">
</p>

<p align="center">
  <a href="https://bloomtutor.app"><strong>🌐 官网</strong></a> · 简体中文 · <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://bloomtutor.app"><img src="assets/hero.png" alt="Bloom — 从平均水平到前 2%" width="820"></a>
</p>

---

1984 年，教育心理学家 Benjamin Bloom 发现：接受**一对一导师指导**的学生，成绩比传统课堂学生高出 **2 个标准差（+2σ）**——直接跃升到**前 2%**。Bloom 称之为"2 Sigma Problem"：效果已被证明，但私人导师太贵、无法规模化。

**Bloom 用 AI 解决这个问题。** 它生成结构化大纲，逐篇递送课文，读取你的批注和反馈，然后根据你的实际理解水平定制下一篇——就像一个真正的导师一样。

## 两种使用方式

| 方式 | 配置 | 适合 |
|------|------|------|
| **CLI 模式** | Claude Code + 终端 | 喜欢用 Markdown 编辑器的人 |
| **Web 模式** | 浏览器（Next.js + FastAPI），自己部署 | 偏好可视化界面、想用自己的资料和 PDF 的人 |

两种模式遵循相同流程：**大纲 → 课文 → 批注 → 反馈 → 下一篇 → 评估 → 总结**。

---

## 快速开始：CLI 模式

只需要 [Claude Code](https://claude.com/claude-code)，无需后端。

```bash
git clone https://github.com/Li-Evan/Bloom.git
cd Bloom

# 将导师 skill 安装到当前 clone 的本地 Claude Code skills 目录
mkdir -p .claude/skills
cp -R skills/bloom-tutor .claude/skills/

claude
```

然后说：`开一个新的文件夹，帮助我学习 [任意课题]`

**或者作为插件安装**（打包了 `bloom-tutor` 和全部 `learn-*` skill）—— 在 Claude Code 里：

```text
/plugin marketplace add Li-Evan/Bloom
/plugin install bloom@li-evan
```

详见 [GUIDE.zh.md](./GUIDE.zh.md)。

## 快速开始：Web 模式

Web 版是自己部署、只给自己用的 AI 私教：没有账号，也不收费。你用自己的模型 API Key（任意 OpenAI 兼容接口），学的东西都存在你自己的数据库里。

### 前置条件

- Python 3.11+，已安装 [uv](https://docs.astral.sh/uv/)
- Node.js 20+，已安装 [pnpm](https://pnpm.io/)
- 任意 OpenAI 兼容聊天模型的 API Key（OpenAI、DeepSeek、通义千问、Moonshot、本地的 Ollama 等）

### 安装

```bash
git clone https://github.com/Li-Evan/Bloom.git
cd Bloom

make setup          # 生成 .env（带随机的 BACKEND_JWT_SECRET），装好前后端依赖
# 编辑 .env：填上 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL

make dev-backend    # 终端 1：先跑数据库迁移，再在 127.0.0.1:8000 启动后端
make dev-frontend   # 终端 2：在 http://localhost:3000 启动网页
```

打开 http://localhost:3000，点「新建课程」开始学习。

### Docker 部署

```bash
make setup                   # 或者自己 cp .env.example .env 再填好
docker compose up -d --build # 然后打开 http://localhost:3000
```

数据存在 `bloom-storage` 卷里：一个 SQLite 数据库，加上资料里的图片。想用 Postgres，在 `.env` 里设 `DATABASE_URL`。

### 配置

| 变量 | 作用 |
|------|------|
| `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` | 生成大纲、课文和回答用的模型 |
| `LLM_FAST_MODEL` | 可选。知识地图、课程定位、划线翻译用的小模型 |
| `PDF_READING_MODEL` | 可选。「PDF 阅读版」把页面图片转成文字用的模型，要能看图 |
| `LLM_EXTRA_BODY` | 每次调用原样带上的 `extra_body`（JSON），例如给 DeepSeek 关掉推理：`{"thinking":{"type":"disabled"}}` |
| `BACKEND_JWT_SECRET` | 前端服务端和后端共用的密钥；后端只认这把密钥签的令牌 |
| `DATABASE_URL` | 默认是 `backend/storage/bloom.sqlite3` |
| `LANGFUSE_*` | 可选。把每次模型调用记到 [Langfuse](https://langfuse.com) |

### 安全

Bloom 没有登录：能打开网页的人，就被当成你本人。所以请只在本机使用；要放到公网上，先在外面套一层鉴权，比如 VPN、Tailscale，或者带 basic auth 的反向代理。`docker compose` 不会把后端端口暴露出去，后端也只接受用 `BACKEND_JWT_SECRET` 签过的请求。

### 从旧版（Vite）升级

Web 版改用 Next.js 重写，数据库结构也换了新的。旧的 `bloom.db` 不会迁移过来，新版从 `backend/storage/` 里的空数据库开始。

---

## 工作流程

### 按主题或用自己的资料建课

```
写下想学什么（可以附上资料）→ Bloom 追问几个和目标有关的问题
                  ↓
    生成大纲：学完能做到什么、按什么顺序学 → 先看大纲，可以修改
                  ↓
    读第一篇 → 划线提问 → 写反馈 → 回答思考题
                  ↓
    点「我读完了」→ 下一篇先点评你的回答、解答你划线问的地方，按你的反馈调整，再往下讲
                  ↓
    重复，直到大纲的掌握项全部覆盖 ✅ → 评估篇 → 课程总结
```

### 项目文件、网页文章、PDF 阅读版

```
上传文件 / 整个文件夹 / 网页链接 / PDF → 每个变成一页（没有大纲）
                  ↓
    阅读 → 划线提问，或者对整页提问 → 标记已读、归档
                  ↓
    读过的内容会进入知识地图和下一步推荐
```

## 功能特性

**建课方式**
- **按主题**：说想学什么，Bloom 先问几个和目标有关的问题，再按你选的深度（简单 / 标准 / 深入）设计大纲
- **用自己的资料**：上传 PDF、Word、PowerPoint、Excel、EPUB、Markdown 或文本（也可以打包成 ZIP）。Bloom 把资料整理成知识包，大纲和课文都以它为依据，并标注出处
- **项目文件**：上传文件或整个文件夹，每个文件是一页，直接读、直接问，不需要大纲
- **网页文章**：贴一个链接，导入正文和图片；也可以用[浏览器剪藏插件](./extension/)存下正在看的网页
- **PDF 阅读版**（实验）：用能看图的模型把每一页 PDF 转成能重排的 Markdown，公式、表格、插图按原来的位置排好，原 PDF 一起保留

**学习**
- **先看大纲**：第一篇之前先过一遍大纲，可以直接改，也可以说想怎么改
- **自适应课文**：每一篇先点评上一篇思考题的回答，再解答你划线问的地方，并照你的反馈调整（短一点、多举例、慢一点……）；最后一篇是评估篇，之后生成课程总结
- **划线提问**：选中任意一段（PDF 里也行）就能提问，同一处可以接着追问；也可以只标记、不提问
- **问这篇**：不用划线，对整篇课文或整个文件提问
- **划线翻译**：把一段译成界面语言，附上它在这里的意思；翻单词和短语时附上词根拆解
- **教学风格**：几种预设（简洁、类比、严谨……），也可以写你自己的要求，对所有课程生效
- **阅读体验**：目录、阅读时长、字号、字体、亮暗主题、中英文界面

**看到全局**
- **知识地图**：每门课都落在一棵共用的知识树上（维基百科 Vital Articles 的冻结快照），能看到你实际读过的主题，以及相邻可以接着学的方向
- **下一步学习**：根据学习记录推荐三个能直接建课的主题，可以收进待学清单，也可以直接开始
- **用户中心**：学习热力图和连续天数、所有划线笔记集中在一处、导出成 Markdown
- **资料课当文件夹用**：资料类课程里的文件可以移动、改名、编辑、归档、删除

## Skills 技能

Bloom 在 [`skills/`](./skills/) 里附带一组可移植的 **[Claude Code](https://claude.com/claude-code) skill** —— 自包含的能力包，拷进 `~/.claude/skills/`（全局）或任意项目的 `.claude/skills/` 即可随处使用。

| Skill | 作用 |
|-------|------|
| **bloom-tutor** | 把整套交互式学习系统封装成一个 skill —— 大纲 → 自适应课文 → `???` 批注 → 评估 → 总结。就是 CLI 模式，打包成可移植形态 |
| **learn-deep** | 深度学习默认入口 —— 一次跑完下面五种视角，再帮你选深入方向 |
| **learn-crossover** | 用你已掌握的知识撬动新概念（结构类比） |
| **learn-occam** | 判断某个东西该不该学、学到什么程度（ROI、够用就好） |
| **learn-graph** | 为一个领域建知识图谱地图 + 学习路径 |
| **learn-prototype** | 用「先做最垃圾的能跑原型再迭代」来学 |
| **learn-feynman** | 用「讲给别人听」自查是否真懂 |

每个文件夹都零依赖：拷进任意 skills 目录，然后直接对 Claude Code 说话（如 *「帮我学 X」*、*「我读完了」*）。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python、FastAPI、SQLAlchemy 2、Alembic；默认 SQLite，也支持 Postgres |
| 前端 | Next.js 15（App Router）、React 19、Tailwind CSS 4、Radix UI、next-intl、pdf.js |
| AI | 任意 OpenAI 兼容的聊天补全接口 |
| 容器 | Docker、docker compose |
| 字体 | Outfit、Public Sans、JetBrains Mono |

## 常用命令

```bash
make setup            # 生成 .env，装好依赖
make dev-backend      # 跑迁移，启动后端（热重载，127.0.0.1:8000）
make dev-frontend     # 启动网页（localhost:3000）
make test             # 后端 pytest + 前端测试
make up / make down   # docker compose 启动 / 停止
```

## 项目结构

```
├── GUIDE.zh.md             # CLI 模式使用说明
├── .env.example            # 配置模板
├── backend/
│   ├── app/                # FastAPI 应用：courses.py（课程引擎）、knowledge*.py / coordinate.py（知识地图）、
│   │                       # lesson_chat.py、translate.py、recommendations.py、上传与导入 ……
│   ├── alembic/            # 数据库迁移（第二个迁移导入知识树）
│   ├── data/knowledge/     # 知识树数据（维基百科 Vital Articles 第 5 级快照）
│   └── tests/
├── frontend/
│   └── src/
│       ├── app/[locale]/   # 页面：/learn（课程、课文、地图、下一步），/me（用户中心）
│       ├── components/     # learn/、me/、site/（顶栏、页脚）、ui/
│       └── lib/            # 接口封装、课文逻辑
├── extension/              # 浏览器网页剪藏插件
├── docs/ARCHITECTURE.md    # 各部分怎么配合
├── example/                # CLI 模式的预制主题
├── site/                   # 营销网站（独立的 Astro 静态站，和应用解耦）
└── skills/                 # 可移植的 Claude Code 技能（bloom-tutor + learn-*）
```

## 背后的科学

| 概念 | 含义 |
|------|------|
| **Bloom 2 Sigma** | 一对一导师 vs 课堂 = +2σ 成绩提升 |
| **掌握学习法** | 真正掌握后才推进到下一个概念 |
| **苏格拉底式教学** | 用提问引导，不直接给答案 |
| **间隔检索** | 每篇课文开头的思考题复盘强化记忆 |
| **自适应路径** | 内容根据个体反馈实时调整 |

## 星标历史

<a href="https://star-history.com/#Li-Evan/Bloom&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Li-Evan/Bloom&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Li-Evan/Bloom&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Li-Evan/Bloom&type=Date" width="640" />
  </picture>
</a>

## 许可

[MIT](LICENSE)。第三方组件、字体和知识树数据沿用各自的许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
