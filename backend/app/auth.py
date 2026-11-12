"""开源版的鉴权：只有一个本地用户，没有登录页。

前端服务端（Next.js）用 BACKEND_JWT_SECRET 给本地用户签短期访问令牌，浏览器的请求经前端的 /api/backend 代理带上它。
后端只认这把密钥签的令牌：后端端口即使被别人访问到，没有密钥也调不动。令牌里的用户第一次出现时自动建出来。
"""
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import ExpiredSignatureError, JWTError, jwt
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User

TOKEN_ISSUER = "bloom-frontend"
CLOCK_SKEW_SECONDS = 30

bearer = HTTPBearer(auto_error=False)


def decode_token(token: str) -> dict:
    try:
        claims = jwt.decode(
            token,
            settings.BACKEND_JWT_SECRET,
            algorithms=["HS256"],
            issuer=TOKEN_ISSUER,
            options={"leeway": CLOCK_SKEW_SECONDS, "require_exp": True, "require_sub": True},
        )
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="访问令牌已过期，请刷新页面")
    except JWTError:
        raise HTTPException(status_code=401, detail="访问令牌无效，请检查前后端的 BACKEND_JWT_SECRET 是否一致")
    if claims.get("scope") != "user":
        raise HTTPException(status_code=401, detail="令牌类型不符")
    return claims


def _ensure_user(db: Session, claims: dict) -> User:
    user = db.query(User).filter(User.uuid == claims["sub"]).first()
    if user is not None:
        return user
    if len(claims["sub"]) > 255:
        raise HTTPException(status_code=401, detail="访问令牌无效，请检查前后端的 BACKEND_JWT_SECRET 是否一致")
    name = (claims.get("name") or "").strip()[:255] or None
    db.add(User(uuid=claims["sub"], email=(claims.get("email") or f"{claims['sub']}@bloom.local")[:255], nickname=name))
    try:
        db.commit()
    except IntegrityError:
        # 同一个用户的两个请求同时到：另一个已经建好了
        db.rollback()
    return db.query(User).filter(User.uuid == claims["sub"]).one()


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="缺少访问令牌")
    return _ensure_user(db, decode_token(credentials.credentials))
