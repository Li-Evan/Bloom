from app.database import connect_args_for, make_engine


def test_postgres_sessions_are_pinned_to_utc():
    assert connect_args_for("postgresql+psycopg://bloom:bloom@localhost:54329/bloom") == {"options": "-c timezone=utc"}


def test_sqlite_connect_args_unchanged():
    assert connect_args_for("sqlite:///bloom.db") == {"check_same_thread": False}


def test_postgres_engine_checks_pooled_connections_before_handing_them_out():
    assert make_engine("postgresql+psycopg://bloom:bloom@localhost:54329/bloom").pool._pre_ping is True


def test_sqlite_engine_keeps_the_default_pool_behaviour():
    assert make_engine("sqlite://").pool._pre_ping is False
