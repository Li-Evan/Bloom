import asyncio
import json
import logging
import re

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["batch"])

# 前端把同一时刻的多个 GET 合成这一个请求，在本进程里并发执行，每条子请求一完成就以一行 JSON 流回（NDJSON），
# 先好的先用，慢的那条不拖住别的。
MAX_REQUESTS = 12
_PATH = re.compile(r"/api/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[^#\s]*)?")
_SKIPPED_HEADERS = {"host", "content-length", "content-type", "transfer-encoding", "connection", "accept-encoding"}
_KEPT_RESPONSE_HEADERS = ("retry-after",)


class BatchRequest(BaseModel):
    paths: list[str]


def _check_path(path: str) -> str:
    route = path.split("?", 1)[0]
    if (
        not _PATH.fullmatch(path)
        or "//" in route
        or any(part in (".", "..") for part in route.split("/"))
        or route.rstrip("/") == "/api/batch"
    ):
        raise HTTPException(status_code=422, detail=f"不能合并的请求路径：{path[:200]}")
    return path


async def _run(client: httpx.AsyncClient, index: int, path: str, headers: dict[str, str]) -> dict:
    try:
        response = await client.get(path, headers=headers)
    except Exception:
        # 子请求在应用之外就失败了（应用自己的异常已由异常处理变成 500 响应）：只这一条报错，别的照常返回
        logger.exception("batched GET %s failed", path.split("?", 1)[0])
        return {"i": index, "status": 502, "body": {"detail": "服务器出了点问题，请稍后重试"}}
    kept = {name: response.headers[name] for name in _KEPT_RESPONSE_HEADERS if name in response.headers}
    line = {"i": index, "status": response.status_code, **({"headers": kept} if kept else {})}
    try:
        return {**line, "body": response.json() if response.content else None}
    except ValueError:
        # 不是 JSON（纯文本错误页之类）：原样带回，前端按单独请求时的同一套逻辑处理
        return {**line, "text": response.text[:4000]}


@router.post("/batch")
async def batch(body: BatchRequest, request: Request):
    if not 1 <= len(body.paths) <= MAX_REQUESTS:
        raise HTTPException(status_code=422, detail=f"一次最多合并 {MAX_REQUESTS} 个请求")
    paths = [_check_path(path) for path in body.paths]
    # 子请求原样带上调用方自己的身份头，走完整的中间件和异常处理，结果与单独请求一致
    headers = {name: value for name, value in request.headers.items() if name not in _SKIPPED_HEADERS}
    transport = httpx.ASGITransport(app=request.app, raise_app_exceptions=False)

    async def lines():
        async with httpx.AsyncClient(transport=transport, base_url=str(request.base_url)) as client:
            tasks = [asyncio.create_task(_run(client, i, path, headers)) for i, path in enumerate(paths)]
            try:
                for done in asyncio.as_completed(tasks):
                    yield json.dumps(await done, ensure_ascii=False) + "\n"
            finally:
                # 调用方中途断开时不再做剩下的子请求
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
