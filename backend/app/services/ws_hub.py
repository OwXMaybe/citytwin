"""Per-city WebSocket fan-out for live sensor updates."""

import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger(__name__)


class Hub:
    def __init__(self) -> None:
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def join(self, city_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._subs[city_id].add(ws)

    async def leave(self, city_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._subs[city_id].discard(ws)

    def count(self, city_id: str | None = None) -> int:
        return len(self._subs[city_id]) if city_id else sum(len(s) for s in self._subs.values())

    async def broadcast(self, city_id: str, message: dict) -> int:
        async with self._lock:
            targets = list(self._subs[city_id])
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:  # client went away mid-send
                dead.append(ws)
        for ws in dead:
            await self.leave(city_id, ws)
        return len(targets) - len(dead)
