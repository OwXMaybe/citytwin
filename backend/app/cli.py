"""Operational commands.

    python -m app.cli migrate
    python -m app.cli load-districts [--force]
    python -m app.cli poll [city]          # one sensor poll, prints a summary
    python -m app.cli anomalies [city]     # anomaly scan of stored readings
"""

import argparse
import asyncio
import json

from .cities import CITIES
from .config import get_settings
from .db import create_pool, migrate
from .services import anomalies
from .services.districts import load_all
from .services.sensors import SensorService
from .services.ws_hub import Hub
from .upstream import make_client


async def main() -> None:
    p = argparse.ArgumentParser(prog="app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    ld = sub.add_parser("load-districts")
    ld.add_argument("--force", action="store_true")
    po = sub.add_parser("poll")
    po.add_argument("city", nargs="?", choices=list(CITIES))
    an = sub.add_parser("anomalies")
    an.add_argument("city", nargs="?", choices=list(CITIES))
    args = p.parse_args()

    settings = get_settings()
    pool = await create_pool(settings.database_url)
    try:
        applied = await migrate(pool)
        if args.cmd == "migrate":
            print(f"applied: {applied or 'nothing (up to date)'}")
        elif args.cmd == "load-districts":
            print(json.dumps(await load_all(pool, settings.districts_dir, force=args.force)) or "unchanged")
        elif args.cmd == "poll":
            async with make_client() as client:
                svc = SensorService(pool, client, settings, Hub())
                for city in [args.city] if args.city else list(CITIES):
                    feed = await svc.poll_city(city)
                    print(f"{city}: {len(feed['stations'])} stations, {len(feed['history'])} history points, "
                          + ", ".join(f"{s['id']}={s['state']}" for s in feed["sources"]))
        elif args.cmd == "anomalies":
            for city in [args.city] if args.city else list(CITIES):
                r = await anomalies.run(pool, city)
                cov = ", ".join(f"{p}: {c['stations']} st / {c['withHistory']} hist / {c['withNeighbours']} nb{' / IF' if c['isolationForest'] else ''}" for p, c in r["coverage"].items())
                print(f"{city}: {len(r['anomalies'])} anomalies, {len(r['episodes'])} episodes ({cov})")
                for a in r["anomalies"][:8]:
                    print(f"  [{a['severity']}] {a['kind']} {a['sensorName']} ({a['district']}): {a['explanation']}")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
