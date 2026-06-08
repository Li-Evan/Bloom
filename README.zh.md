<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo.svg">
    <img alt="Bloom" src="assets/logo.svg" width="360">
  </picture>
</p>

<p align="center">
  <strong>你的私人 AI 导师 — 基于 2-Sigma 方法论</strong>
</p>

<p align="center">
  <em>从平均水平到前 2%，一篇课文一步脚印。</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/python-3.11+-blue.svg" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/node-18+-blue.svg" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/react-19-blue.svg" alt="React 19">
  <img src="https://img.shields.io/badge/fastapi-0.115+-blue.svg" alt="FastAPI">
</p>

<p align="center">
  <a href="https://li-evan.github.io/Bloom/"><strong>🌐 官网</strong></a> · 简体中文 · <a href="./README.md">English</a>
</p>

---

1984 年，教育心理学家 Benjamin Bloom 发现：接受**一对一导师指导**的学生，成绩比传统课堂学生高出 **2 个标准差（+2σ）**——直接跃升到**前 2%**。Bloom 称之为"2 Sigma Problem"：效果已被证明，但私人导师太贵、无法规模化。

**Bloom 用 AI 解决这个问题。** 它生成结构化大纲，逐篇递送课文，读取你的批注和反馈，然后根据你的实际理解水平定制下一篇——就像一个真正的导师一样。

## 两种使用方式

| 方式 | 配置 | 适合 |
|------|------|------|
| **CLI 模式** | Claude Code + 终端 | 喜欢用 Markdown 编辑器的人 |
| **Web 模式** | 浏览器（React + FastAPI） | 偏好可视化界面的人 |

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

详见 [GUIDE.zh.md](./GUIDE.zh.md)。

## 快速开始：Web 模式

### 前置条件

- Python 3.11+，已安装 [uv](https://docs.astral.sh/uv/)
- Node.js 18+
- 任意 OpenAI 兼容的 LLM API Key（如 [DashScope](https://dashscope.console.aliyun.com/)、OpenAI 等）

### 安装

```bash
git clone https://github.com/Li-Evan/Bloom.git
cd Bloom

# 配置
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY

# 后端
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000

# 前端（新终端）
cd frontend && npm install && npm run dev
```

打开 http://localhost:5173，点击「新建课程」，选择「主题生成」或「上传原文」，再选择学习深度，开始学习。

### Docker 部署

```bash
cp .env.example .env   # 填入 API Key
docker compose up -d   # 访问 http://localhost:3000
```

---

## 工作流程

### 主题生成

```
创建课程 → AI 生成大纲 + 首篇课文
                  ↓
    阅读课文 → 选中文字 → 添加批注
                  ↓
    写反馈 → 回答思考题
                  ↓
    点击「我读完了」→ AI 生成下一篇
   （包含：思考题复盘 + 批注解答 + 新内容）
                  ↓
    重复，直到大纲所有掌握项全部 ✅
                  ↓
    自动生成评估篇 → 然后生成总结
```

### 上传原文

```
上传 PDF / TXT / MD → AI 根据全文生成大纲 + 原文阅读章
                         ↓
      阅读原文 → 选中文字 → 即时提问并得到回答
                         ↓
      点击「我读完原文了」→ AI 读取全文 + 划线问答，生成下一篇
                         ↓
      后续按主题生成模式继续推进
```

## 功能特性

- **两种课程模式** — 主题生成，或上传 PDF/TXT/MD 原文学习
- **学习深度** — 创建课程时选择简单、标准或深入，控制大纲展开颗粒度
- **参考材料** — 创建主题课程时粘贴课本、论文、笔记，AI 据此设计课程
- **下一步学习推荐** — 根据完整学习历史生成 3 个可直接创建课程的主题，支持刷新、收藏到待学习清单、或直接进入“大纲 → 课文”的学习流程
- **划线问答会话** — 任意课文（或原文）中选中文字后会冒出一个小图标，点它再提问；划线处持续标黄，AI 立即作答，可在同一会话中持续追问。窗口可拖动，可缩小为右侧小圆点、随时点开。每条会话的上下文 = 整篇课文 + 划线那段 + 本会话对话；你的提问仍会喂入下一篇课文生成
- **自适应课文** — 每篇新课文针对你上一篇的薄弱点定制
- **章节导航** — 右侧侧栏快速跳转
- **可折叠大纲** — 随时查看掌握进度
- **流式生成** — 实时看 AI 写下一篇课文
- **个人中心与学习日历** — 顶栏进入个人中心，月历按强度着色展示每天学习量，点某天即可看到当天学了哪些课程、第几篇、提了几条划线；配学习概览统计卡与近半年学习足迹热力图（连续天数等口径统一按本地日期）

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
| 后端 | Python, FastAPI, SQLAlchemy, SQLite |
| 前端 | React, Vite, Tailwind CSS |
| AI | 任意 OpenAI 兼容 LLM API |
| 容器 | Docker, docker-compose |
| 字体 | Outfit, JetBrains Mono |

## 常用命令

```bash
make dev-backend      # 启动后端（热重载）
make dev-frontend     # 启动前端
make test             # 运行测试
make up / make down   # Docker 启动 / 停止
```

## 背后的科学

| 概念 | 含义 |
|------|------|
| **Bloom 2 Sigma** | 一对一导师 vs 课堂 = +2σ 成绩提升 |
| **掌握学习法** | 真正掌握后才推进到下一个概念 |
| **苏格拉底式教学** | 用提问引导，不直接给答案 |
| **间隔检索** | 每篇课文开头的思考题复盘强化记忆 |
| **自适应路径** | 内容根据个体反馈实时调整 |

## 许可

[MIT](LICENSE)
