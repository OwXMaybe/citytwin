import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from ..cities import CITIES

log = logging.getLogger(__name__)
router = APIRouter(tags=["sensors"])


@router.get("/api/v1/cities/{city_id}/stations")
async def city_stations(city_id: str, request: Request):
    if city_id not in CITIES:
        raise HTTPException(404, f"Unknown city '{city_id}'")
    return await request.app.state.sensors.snapshot(city_id)


@router.get("/api/v1/cities/{city_id}/anomalies")
async def city_anomalies(city_id: str, request: Request, refresh: bool = False):
    """Latest anomaly scan of measured readings (runs one if none is cached or refresh=true)."""
    if city_id not in CITIES:
        raise HTTPException(404, f"Unknown city '{city_id}'")
    sensors = request.app.state.sensors
    cached = sensors.anomalies.get(city_id)
    return cached if cached and not refresh else await sensors.detect(city_id)


@router.get("/api/v1/stations/{station_id}/history")
async def station_history(station_id: str, request: Request, hours: int = Query(48, ge=1, le=336)):
    rows = await request.app.state.pool.fetch(
        """SELECT pollutant, measured_at, value FROM reading
           WHERE sensor_id = $1 AND measured_at > now() - make_interval(hours => $2)
           ORDER BY measured_at""",
        station_id,
        hours,
    )
    if not rows:
        raise HTTPException(404, "No readings stored for this station in the window")
    series: dict[str, list] = {}
    for r in rows:
        series.setdefault(r["pollutant"], []).append({"time": r["measured_at"].isoformat(), "value": r["value"]})
    return {"stationId": station_id, "hours": hours, "series": series}


@router.websocket("/ws/sensors")
async def sensors_ws(ws: WebSocket, city: str):
    """Sends a snapshot on connect, then an `update` after every poll of that city."""
    if city not in CITIES:
        await ws.close(code=4404, reason="unknown city")
        return
    await ws.accept()
    app = ws.app
    await app.state.hub.join(city, ws)
    try:
        snapshot = await app.state.sensors.snapshot(city)
        await ws.send_json({"type": "snapshot", "city": city, "feed": snapshot})
        if cached := app.state.sensors.anomalies.get(city):
            await ws.send_json({"type": "anomalies", "city": city, "result": cached})
        while True:
            # Clients may send "ping"; anything else is ignored. Times out to send a heartbeat.
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=30)
                if msg == "ping":
                    await ws.send_json({"type": "pong"})
            except TimeoutError:
                await ws.send_json({"type": "heartbeat"})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("websocket error")
    finally:
        await app.state.hub.leave(city, ws)
