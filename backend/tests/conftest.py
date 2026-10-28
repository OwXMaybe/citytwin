import socket

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def _db_up(host: str = "127.0.0.1", port: int = 54329) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


requires_db = pytest.mark.skipif(not _db_up(), reason="PostGIS not running (pwsh backend/scripts/db.ps1 start)")


@pytest.fixture(scope="session")
def settings() -> Settings:
    # No background polling and no API keys: tests never hit the network by themselves.
    return Settings(poller_enabled=False, openaq_api_key=None, anthropic_api_key=None)


@pytest.fixture(scope="session")
def client(settings):
    if not _db_up():
        pytest.skip("PostGIS not running")
    with TestClient(create_app(settings)) as c:
        yield c
