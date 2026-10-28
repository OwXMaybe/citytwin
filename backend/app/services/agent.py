"""CityTwin AI: a Claude agent that answers questions by calling CityTwin's own data tools.

The loop is a manual tool-use loop over the streaming Messages API, so the browser can
show text as it arrives and each tool call as it happens (as server-sent events).
The API key never leaves the backend.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime, timezone

import anthropic

from ..cities import CITIES
from ..config import Settings
from .ai_tools import TOOLS, ToolContext, execute

log = logging.getLogger(__name__)

# Frozen so the tools + system prefix stays cacheable; per-request facts go in the user turn.
_CITY_LIST = ", ".join(c.name for c in CITIES.values())
SYSTEM_PROMPT = f"""You are CityTwin AI, the analyst inside CityTwin, an urban digital-twin dashboard covering {_CITY_LIST}.

You answer questions with tools that query CityTwin's PostGIS database and the live public feeds it caches: OpenStreetMap district boundaries, ground air-quality stations (İBB reference monitors, Sensor.Community low-cost sensors, OpenAQ), CityTwin's anomaly detector, Open-Meteo weather and CAMS air-quality model output, and live traffic for Istanbul, London and New York.

How to answer:
- Every figure you state must come from a tool result in this conversation. Do not estimate, recall or invent measurements. If no tool covers the question, say so plainly and say what data would be needed.
- Say where each figure comes from and how current it is. Keep three kinds of data apart: sensor measurements (say whether from reference monitors or low-cost sensors, which are indicative rather than regulatory-grade), model output (Open-Meteo / CAMS), and CityTwin estimates (anomaly flags, derived indices).
- Energy use, building energy, noise, demographics without an OSM population tag, and per-road traffic outside London and New York are simulated in the dashboard and are not available to you. If asked about them, say they are simulated and that you can't analyse them.
- An anomaly is a statistical flag, not a confirmed event. A local hotspot seen by a single low-cost sensor is often a sensor fault; say so.
- For air quality, compare with the WHO 2021 guidelines where useful (24-hour means: PM2.5 15, PM10 45, NO2 25 µg/m³; annual PM2.5 5 µg/m³), noting that a single hourly value is not a 24-hour mean.
- Tool times are UTC; convert to the city's local time when you mention them.
- The user's dashboard city is stated at the start of their message. Use it unless they name another city.
- Reply in the user's language. Lead with the answer, then the supporting figures, then a one-line "Sources:" list. Keep it short; use a small Markdown list or table only when it helps."""

BETAS = ["server-side-fallback-2026-07-01"]
MAX_TOKENS = 16_000
JSON_RETRIES = 2


def _context_line(city_id: str) -> str:
    c = CITIES[city_id]
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return f"[Dashboard city: {c.name} (id: {c.id}, timezone {c.timezone}). Current time: {now}]"


def build_messages(city_id: str, history: list[dict]) -> list[dict]:
    """Client history is plain text turns; the city/time line is prepended to the newest question."""
    messages = [{"role": m["role"], "content": m["content"]} for m in history]
    messages[-1] = {"role": "user", "content": f"{_context_line(city_id)}\n\n{messages[-1]['content']}"}
    return messages


class Agent:
    def __init__(self, settings: Settings, client: anthropic.AsyncAnthropic | None):
        self.settings = settings
        self.client = client

    @classmethod
    def from_settings(cls, settings: Settings) -> "Agent":
        key = settings.anthropic_api_key
        return cls(settings, anthropic.AsyncAnthropic(api_key=key) if key else None)

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def status(self) -> dict:
        return {"enabled": self.enabled, "model": self.settings.ai_model if self.enabled else None, "effort": self.settings.ai_effort}

    async def run(self, ctx: ToolContext, city_id: str, history: list[dict]) -> AsyncIterator[dict]:
        """Yields UI events: text, tool_use, tool_result, fallback, refusal, error, done."""
        assert self.client is not None
        messages = build_messages(city_id, history)
        usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        model_used = self.settings.ai_model
        stop_reason = None
        json_retries = 0
        step = 0

        while step < self.settings.ai_max_steps:
            try:
                async with self.client.beta.messages.stream(
                    model=self.settings.ai_model,
                    max_tokens=MAX_TOKENS,
                    system=SYSTEM_PROMPT,
                    tools=TOOLS,
                    messages=messages,
                    thinking={"type": "adaptive"},
                    output_config={"effort": self.settings.ai_effort},
                    cache_control={"type": "ephemeral"},
                    betas=BETAS,
                    fallbacks="default",  # on a safety decline the API retries on Anthropic's recommended model
                ) as stream:
                    async for event in stream:
                        if event.type == "text":
                            yield {"type": "text", "step": step, "text": event.text}
                        elif event.type == "content_block_start":
                            block = event.content_block
                            if block.type == "tool_use":
                                yield {"type": "tool_start", "step": step, "id": block.id, "name": block.name}
                            elif block.type == "fallback":
                                # The next model re-answers; the client drops this step's partial text.
                                yield {"type": "fallback", "step": step,
                                       "from": getattr(getattr(block, "from_", None), "model", None),
                                       "to": getattr(getattr(block, "to", None), "model", None)}
                    response = await stream.get_final_message()
                json_retries = 0
            except ValueError:
                # Tool input JSON the SDK could not parse (eager input streaming). Re-issue the step.
                json_retries += 1
                if json_retries > JSON_RETRIES:
                    yield {"type": "error", "message": "The model produced an unreadable tool call. Please try again."}
                    return
                yield {"type": "retry", "step": step}
                continue
            except anthropic.AuthenticationError:
                yield {"type": "error", "message": "The backend's ANTHROPIC_API_KEY was rejected."}
                return
            except anthropic.RateLimitError:
                yield {"type": "error", "message": "Rate limited by the Claude API. Wait a moment and try again."}
                return
            except anthropic.APIStatusError as e:
                log.warning("Claude API error %s: %s", e.status_code, e.message)
                yield {"type": "error", "message": f"Claude API error {e.status_code}."}
                return
            except anthropic.APIConnectionError:
                yield {"type": "error", "message": "Could not reach the Claude API."}
                return

            u = response.usage
            usage["input"] += u.input_tokens or 0
            usage["output"] += u.output_tokens or 0
            usage["cacheRead"] += getattr(u, "cache_read_input_tokens", 0) or 0
            usage["cacheWrite"] += getattr(u, "cache_creation_input_tokens", 0) or 0
            model_used, stop_reason = response.model, response.stop_reason

            if stop_reason == "refusal":
                details = getattr(response, "stop_details", None)
                yield {"type": "refusal", "step": step, "category": getattr(details, "category", None)}
                break
            if stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": response.content})
                continue

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if not tool_uses:
                break
            if stop_reason == "max_tokens":
                yield {"type": "error", "message": "The answer hit the length limit before a tool call finished."}
                break

            for b in tool_uses:
                yield {"type": "tool_use", "step": step, "id": b.id, "name": b.name, "input": b.input}
            ctx_results = await asyncio.gather(*(execute(ctx, b.name, b.input) for b in tool_uses))
            results = []
            for b, (ok, text) in zip(tool_uses, ctx_results):
                yield {"type": "tool_result", "step": step, "id": b.id, "name": b.name, "ok": ok, "provenance": _provenance(text)}
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": text, **({} if ok else {"is_error": True})})
            # Append-only: the assistant turn exactly as returned (thinking blocks included), then all results in one user turn.
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": results})
            step += 1
        else:
            yield {"type": "error", "message": f"Stopped after {self.settings.ai_max_steps} tool rounds without a final answer."}

        yield {"type": "done", "model": model_used, "stopReason": stop_reason, "usage": usage}


def _provenance(text: str) -> dict | None:
    try:
        p = json.loads(text).get("provenance")
    except (ValueError, AttributeError):
        return None
    return p if isinstance(p, dict) else None
