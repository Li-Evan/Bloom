from typing import Annotated, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy.orm import Query as OrmQuery

T = TypeVar("T")

# 页码上限：再大的页码没有对应的数据，放行只会让 OFFSET 溢出变成 500
MAX_PAGE = 10_000
MAX_LIMIT = 200

PageQuery = Annotated[int, Query(ge=1, le=MAX_PAGE)]
LimitQuery = Annotated[int, Query(ge=1, le=MAX_LIMIT)]


class Page(BaseModel, Generic[T]):
    items: list[T]
    page: int
    limit: int
    total: int


def paginate(query: OrmQuery, page: int, limit: int) -> dict:
    return {
        "items": query.offset((page - 1) * limit).limit(limit).all(),
        "page": page,
        "limit": limit,
        "total": query.count(),
    }
