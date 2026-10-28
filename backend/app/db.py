"""asyncpg pool + a minimal forward-only SQL migration runner."""

import json
import logging
from pathlib import Path

import asyncpg

from .cities import CITIES

log = logging.getLogger(__name__)
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


async def _init_connection(conn: asyncpg.Connection) -> None:
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=1, max_size=10, init=_init_connection, command_timeout=60)


async def migrate(pool: asyncpg.Pool) -> list[str]:
    """Apply pending migrations in filename order; returns the versions applied."""
    applied: list[str] = []
    async with pool.acquire() as conn:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        done = {r["version"] for r in await conn.fetch("SELECT version FROM schema_migrations")}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.stem in done:
                continue
            async with conn.transaction():
                await conn.execute(path.read_text(encoding="utf-8"))
                await conn.execute("INSERT INTO schema_migrations (version) VALUES ($1)", path.stem)
            applied.append(path.stem)
            log.info("applied migration %s", path.stem)
        await seed_cities(conn)
    return applied


async def seed_cities(conn: asyncpg.Connection) -> None:
    await conn.executemany(
        """INSERT INTO city (id, name, country, timezone, center)
           VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country,
             timezone = EXCLUDED.timezone, center = EXCLUDED.center""",
        [(c.id, c.name, c.country, c.timezone, c.lon, c.lat) for c in CITIES.values()],
    )
