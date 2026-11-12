# 后端应用模块

`backend/app/` 是 Bloom 的 FastAPI 应用：数据库模型、请求与响应模型和各路由模块。它拥有全部持久化数据和全部模型调用，不托管任何界面（界面只在 `frontend/`）。整体结构、请求路径和各模块的分工见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

- `main.py`：创建应用、挂路由、每 10 分钟清理过期上传和孤儿图片。`BACKEND_JWT_SECRET` 为空或短于 32 个字符、`LLM_MODEL` 为空时拒绝启动。
- `config.py`：所有配置都从环境变量读（仓库根的 `.env`）。所有模型都走同一个 OpenAI 兼容网关（`LLM_BASE_URL`、`LLM_API_KEY`）。
- `auth.py`：校验前端服务端签发的 HS256 访问令牌；令牌里的用户第一次出现时自动建出来。
- `database.py`：按 `DATABASE_URL` 建引擎；SQLite 打开外键、WAL 和忙等待。表由 Alembic 迁移（`make migrate`）创建。
- `models.py` / `schemas.py`：表结构和接口的请求、响应模型。所有表按 `user_uuid` 归属。
- `courses.py`：课程引擎。所有模型调用都经 `_chat_completion`。
- `knowledge.py`、`knowledge_graph.py`、`knowledge_catalog.py`、`coordinate.py`：知识地图和课程在知识树上的定位。
- `lesson_chat.py`（问这篇）、`translate.py`（划线翻译）、`highlights.py`（标记）、`notes.py`（我的笔记）、`recommendations.py`（下一步学习）、`teaching.py` / `teaching_styles.py`（教学计划与风格）、`users.py`（个人资料与设置）。
- `uploads.py`、`document_import.py`、`project_archive.py`、`omml.py`、`pdf_reading.py`、`web_import.py`、`clippings.py`、`project_images.py`：上传、各类文件转 Markdown、网页导入与剪藏、PDF 阅读版、资料里的图片。
- `errors.py`：失败报错写成「固定提示（原因：…）」，原因会显示给用户，所以先按正则脱敏（密钥、令牌、URL、邮箱、IP）。
- `observability.py`、`tracing.py`：单行 JSON 的慢请求 / 慢查询日志；可选的 Langfuse 追踪。
