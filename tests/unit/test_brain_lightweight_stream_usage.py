import pytest

from openakita.core._brain_legacy import Brain


class _StreamingClient:
    async def chat_stream(self, **_kwargs):
        yield {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 10, "output_tokens": 0}},
        }
        yield {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text", "text": "hello"},
        }
        yield {
            "type": "message_stop",
            "usage": {"input_tokens": 10, "output_tokens": 2},
        }


@pytest.mark.asyncio
async def test_think_lightweight_stream_preserves_provider_usage():
    brain = Brain.__new__(Brain)
    brain._llm_client = _StreamingClient()
    brain._compiler_client = None
    brain._compiler_available = lambda: False
    brain._dump_llm_request = lambda *args, **kwargs: "request-id"
    brain._dump_llm_response = lambda *args, **kwargs: None

    events = [
        event
        async for event in brain.think_lightweight_stream(
            prompt="hi",
            system="system",
        )
    ]

    assert events == [
        {"type": "text_delta", "content": "hello"},
        {
            "type": "done",
            "usage": {"input_tokens": 10, "output_tokens": 2},
        },
    ]
