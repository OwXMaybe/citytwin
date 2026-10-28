from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    """Runtime configuration. Reads backend/.env and the frontend's .env.local, so
    OPENAQ_API_KEY only has to be set once for both."""

    model_config = SettingsConfigDict(
        env_file=(PROJECT_DIR / ".env.local", BACKEND_DIR / ".env"),
        extra="ignore",
    )

    database_url: str = "postgresql://citytwin@127.0.0.1:54329/citytwin"
    openaq_api_key: str | None = None
    # CityTwin AI (Phase 5). Without a key the frontend keeps its rule-based assistant.
    anthropic_api_key: str | None = None
    ai_model: str = "claude-opus-5-5"
    ai_effort: str = "medium"
    ai_max_steps: int = 8
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
    ]
    poller_enabled: bool = True
    sensor_poll_seconds: int = 600
    districts_dir: Path = PROJECT_DIR / "public" / "data" / "districts"
    frontend_dist: Path = PROJECT_DIR / "dist"


@lru_cache
def get_settings() -> Settings:
    return Settings()
