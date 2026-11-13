from logging.config import fileConfig

from alembic import context

import app.models  # noqa: F401
from app.config import settings
from app.database import Base, make_engine

fileConfig(context.config.config_file_name)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        render_as_batch=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # make_engine 和应用用同一套连接设置（SQLite 的外键、WAL，数据目录不存在时先建出来）
    engine = make_engine(settings.DATABASE_URL)
    with engine.connect() as connection:
        # render_as_batch：SQLite 改表要整表重建，以后的迁移用 batch_alter_table 写，SQLite 和 Postgres 都能跑
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
