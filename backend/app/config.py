import json
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))


def llm_extra_body(raw: str, name: str = "LLM_EXTRA_BODY", example: str = '{"thinking":{"type":"disabled"}}') -> dict:
    """LLM_EXTRA_BODY（LLM_REASONING_EXTRA_BODY 同一套规则，name 和 example 只用在报错里）：一个 JSON 对象字符串，原样作为 extra_body 带进每一次聊天补全调用；空 = 什么都不带。

    最常见的用法是给 DeepSeek 这类带隐藏推理的模型关掉推理：{"thinking":{"type":"disabled"}}。
    不合法（不是 JSON、或不是对象）就拒绝启动，而不是等到第一次调模型才发现。
    """
    raw = raw.strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} 不是合法的 JSON（{exc}）：它应该是一个 JSON 对象，例如 {example}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{name} 必须是 JSON 对象（{{...}}），现在是 {type(value).__name__}：例如 {example}")
    return value


def sqlalchemy_url(url: str) -> str:
    # 托管数据库（Supabase 等）给的是 postgres:// 或 postgresql://，SQLAlchemy 会默认去找没装的 psycopg2
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


class Settings:
    ADAPTIVE_TEACHING: bool = os.getenv("ADAPTIVE_TEACHING", "true").lower() == "true"
    # 任何 OpenAI 兼容的聊天补全接口：OpenAI、DeepSeek、通义千问、Moonshot、本地的 Ollama / vLLM 都行
    LLM_API_KEY: str = os.getenv("LLM_API_KEY", "")
    LLM_BASE_URL: str = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "")  # 必填：例如 gpt-4.1-mini、deepseek-chat、qwen-plus
    # 知识地图、知识坐标、划线翻译这类小任务用的模型（走同一个网关）；空 = 和 LLM_MODEL 一样
    LLM_FAST_MODEL: str = os.getenv("LLM_FAST_MODEL", "") or LLM_MODEL
    LLM_REQUEST_TIMEOUT_SECONDS: int = int(os.getenv("LLM_REQUEST_TIMEOUT_SECONDS", "300"))
    LLM_STREAM_READ_TIMEOUT_SECONDS: int = int(os.getenv("LLM_STREAM_READ_TIMEOUT_SECONDS", "90"))
    LLM_MAX_RETRIES: int = int(os.getenv("LLM_MAX_RETRIES", "1"))
    # 输出上限用哪个参数名：空 = 按模型名猜（gpt- / o 系列用 max_completion_tokens，其它用 max_tokens）
    LLM_MAX_TOKENS_PARAM: str = os.getenv("LLM_MAX_TOKENS_PARAM", "").strip()
    # 原样作为 extra_body 带进每一次模型调用（流式与非流式、课程引擎与推荐）；空 = 不带。启动时解析一次，不合法拒绝启动
    LLM_EXTRA_BODY: dict = llm_extra_body(os.getenv("LLM_EXTRA_BODY", ""))
    # 只给「参考答案核对」这一次调用用的 extra_body，用来打开模型推理（LLM_EXTRA_BODY 通常把推理关了），例如 DeepSeek 是
    # {"thinking":{"type":"enabled"}}；空 = 核对调用和其它调用一样用 LLM_EXTRA_BODY。同样启动时解析、不合法拒绝启动
    LLM_REASONING_EXTRA_BODY: dict = llm_extra_body(
        os.getenv("LLM_REASONING_EXTRA_BODY", ""), name="LLM_REASONING_EXTRA_BODY", example='{"thinking":{"type":"enabled"}}',
    )
    MATERIAL_PARSE_CONCURRENCY: int = int(os.getenv("MATERIAL_PARSE_CONCURRENCY", "4"))
    MATERIAL_TOTAL_TIMEOUT_SECONDS: int = int(os.getenv("MATERIAL_TOTAL_TIMEOUT_SECONDS", "720"))
    PROJECT_MAX_FILES: int = int(os.getenv("PROJECT_MAX_FILES", "50"))
    # PDF 阅读版：逐页看图转 Markdown 的模型，必须能看图（走同一个网关）；空 = 和 LLM_MODEL 一样。
    # 一次最多几个文件、共几页，同时转几页
    PDF_READING_MODEL: str = os.getenv("PDF_READING_MODEL", "") or LLM_MODEL
    PDF_READING_MAX_FILES: int = int(os.getenv("PDF_READING_MAX_FILES", "5"))
    # 一次上传最多转换的总页数，几个文件按顺序分；超过的不拒绝，只转前面这些页（课文开头写明）
    PDF_READING_MAX_PAGES: int = int(os.getenv("PDF_READING_MAX_PAGES", "100"))
    PDF_READING_CONCURRENCY: int = int(os.getenv("PDF_READING_CONCURRENCY", "6"))
    PDF_READING_TIMEOUT_SECONDS: int = int(os.getenv("PDF_READING_TIMEOUT_SECONDS", "600"))

    DATABASE_URL: str = sqlalchemy_url(os.getenv("DATABASE_URL", "sqlite:///./storage/bloom.sqlite3"))
    # 资料里的图片存在这个目录下。数据库和图片默认都在 backend/storage/（运行时数据；backend/data/ 是随代码发布的知识数据）
    IMAGE_STORE_DIR: str = os.getenv("IMAGE_STORE_DIR", "./storage/images")

    # 前端服务端给本地用户签访问令牌用的密钥，前后端必须一致；至少 32 个字符（make setup 会生成一个）
    BACKEND_JWT_SECRET: str = os.getenv("BACKEND_JWT_SECRET", "")
    WEB_URL: str = os.getenv("WEB_URL", "http://localhost:3000")

    # Langfuse observability. Optional: with no key pair (or LANGFUSE_TRACING_ENABLED=false)
    # every tracing helper in app.tracing is a no-op.
    LANGFUSE_PUBLIC_KEY: str = os.getenv("LANGFUSE_PUBLIC_KEY", "")
    LANGFUSE_SECRET_KEY: str = os.getenv("LANGFUSE_SECRET_KEY", "")
    LANGFUSE_BASE_URL: str = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
    LANGFUSE_TRACING_ENABLED: bool = (
        os.getenv("LANGFUSE_TRACING_ENABLED")
        or ("true" if os.getenv("LANGFUSE_PUBLIC_KEY", "") and os.getenv("LANGFUSE_SECRET_KEY", "") else "false")
    ).lower() == "true"
    # production / staging / development
    LANGFUSE_TRACING_ENVIRONMENT: str = os.getenv("LANGFUSE_TRACING_ENVIRONMENT", "")
    LANGFUSE_SAMPLE_RATE: float = float(os.getenv("LANGFUSE_SAMPLE_RATE") or "1.0")
    # Short timeout: observability must never add a long stall to a learner request.
    LANGFUSE_TIMEOUT_SECONDS: int = int(os.getenv("LANGFUSE_TIMEOUT_SECONDS") or "10")
    LANGFUSE_FLUSH_ON_EXIT: bool = (os.getenv("LANGFUSE_FLUSH_ON_EXIT") or "false").lower() == "true"
    LANGFUSE_FLUSH_AT: int | None = int(os.getenv("LANGFUSE_FLUSH_AT")) if os.getenv("LANGFUSE_FLUSH_AT") else None
    LANGFUSE_FLUSH_INTERVAL_SECONDS: float | None = (
        float(os.getenv("LANGFUSE_FLUSH_INTERVAL_SECONDS")) if os.getenv("LANGFUSE_FLUSH_INTERVAL_SECONDS") else None
    )


settings = Settings()


def model_gateway(model: str) -> tuple[str, str]:
    """所有模型都走同一个 OpenAI 兼容网关。"""
    return settings.LLM_BASE_URL, settings.LLM_API_KEY
