.PHONY: setup dev dev-backend dev-frontend migrate build up down logs test test-backend test-frontend

# 第一次用：复制 .env 并生成 BACKEND_JWT_SECRET，再装好前后端依赖
setup:
	@test -f .env || (umask 077 && sed "s|^BACKEND_JWT_SECRET=.*|BACKEND_JWT_SECRET=$$(openssl rand -hex 32)|" .env.example > .env && echo "已生成 .env，记得填上 LLM_API_KEY 和 LLM_MODEL")
	cd backend && uv sync
	cd frontend && pnpm install

migrate:
	cd backend && uv run alembic upgrade head

# 后端只监听本机：它不对外开放，浏览器经前端的同源代理访问
dev-backend: migrate
	cd backend && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

dev-frontend:
	set -a && . ./.env && set +a && cd frontend && BACKEND_URL=http://127.0.0.1:8000 pnpm dev

dev:
	@echo "请在两个终端分别运行:"
	@echo "  make dev-backend"
	@echo "  make dev-frontend"
	@echo "然后打开 http://localhost:3000"

build:
	DOCKER_BUILDKIT=1 docker compose build

up:
	DOCKER_BUILDKIT=1 docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

test: test-backend test-frontend

test-backend:
	cd backend && uv run pytest -q

test-frontend:
	cd frontend && pnpm test
