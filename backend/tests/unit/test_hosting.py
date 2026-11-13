import pytest

from app.config import sqlalchemy_url


@pytest.mark.parametrize(
    "given, expected",
    [
        ("postgres://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db?sslmode=require",
         "postgresql+psycopg://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db?sslmode=require"),
        ("postgresql://u:p@host:5432/db", "postgresql+psycopg://u:p@host:5432/db"),
        ("postgresql+psycopg://bloom:bloom@localhost:54329/bloom", "postgresql+psycopg://bloom:bloom@localhost:54329/bloom"),
        ("sqlite:///bloom.db", "sqlite:///bloom.db"),
    ],
)
def test_hosted_postgres_urls_use_the_installed_psycopg_driver(given, expected):
    assert sqlalchemy_url(given) == expected
