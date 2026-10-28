"""CityTwin AI endpoints: status and a streaming chat (server-sent events)."""

import json
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from ..cities import CITIES
from ..services.ai_tools import ToolContext

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/ai", tags=["ai"])


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    city: str
    messages: list[ChatTurn] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def check(self):
        if self.city not in CITIES:
            raise ValueError(f"Unknown city '{self.city}'")
        if self.messages[0].role != "user" or self.messages[-1].role != "user":
            raise ValueError("Conversation must start and end with a user turn")
        return self


@router.get("/status")
async def status(request: Request):
    return request.app.state.agent.status()


@router.post("/chat")
async def chat(body: ChatRequest, request: Request):
    agent = request.app.state.agent
    if not agent.enabled:
        raise HTTPException(503, "CityTwin AI is not configured: set ANTHROPIC_API_KEY in .env.local and restart the backend")
    state = request.app.state
    ctx = ToolContext(state.pool, state.sensors, state.http)

    async def events():
        try:
            async for event in agent.run(ctx, body.city, [m.model_dump() for m in body.messages]):
                if await request.is_disconnected():
                    log.info("chat client disconnected")
                    return
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
        except Exception as e:  # never leave the client hanging on a half-open stream
            log.exception("chat failed")
            yield f"data: {json.dumps({'type': 'error', 'message': f'{type(e).__name__}: {e}'[:300]})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
