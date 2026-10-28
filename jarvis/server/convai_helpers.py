"""ElevenLabs Conversational AI (ConvAI) — server-side agent + session tokens."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("jarvis.convai")

AGENT_STORE = "data/convai-agent.json"
NEXY_PROMPT = (
    "You are Nexy, Ryan's personal desktop assistant (Dix01-JARVIS). "
    "Concise, warm, lightly Irish cadence in prose — not robotic. "
    "You help with tasks, questions, and quick decisions on his PC. "
    "Keep replies short unless he asks for detail. "
    "Address him as Ryan. You speak for the Nexelyth Collective, not as a butler. "
    "You are not a generic chatbot; you are his always-on HUD voice. "
    "You may write only in nexey-memory. Everything else is read-only. If it matters, it goes in the folder the day it happens."
)


def _api_key(cfg) -> str:
    env_name = getattr(cfg.voice, "elevenlabs_api_key_env", "ELEVENLABS_API_KEY") or "ELEVENLABS_API_KEY"
    return (os.environ.get(env_name) or "").strip()


def _agent_id_env(cfg) -> str:
    env_name = getattr(cfg.voice, "convai_agent_id_env", "ELEVENLABS_AGENT_ID") or "ELEVENLABS_AGENT_ID"
    return (os.environ.get(env_name) or "").strip()


def _agent_store_path(cfg) -> Path:
    return cfg.abs_path(AGENT_STORE)


def load_stored_agent_id(cfg) -> str:
    path = _agent_store_path(cfg)
    if not path.is_file():
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return str(data.get("agent_id") or "").strip()
    except json.JSONDecodeError:
        return ""


def save_stored_agent_id(cfg, agent_id: str) -> None:
    path = _agent_store_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"agent_id": agent_id, "voice_id": getattr(cfg.voice, "elevenlabs_voice_id", "")}, indent=2),
        encoding="utf-8",
    )


def resolve_agent_id(cfg) -> str:
    return _agent_id_env(cfg) or load_stored_agent_id(cfg)


def convai_ready(cfg) -> dict[str, Any]:
    key = bool(_api_key(cfg))
    agent = resolve_agent_id(cfg)
    voice = getattr(cfg.voice, "elevenlabs_voice_id", "") or "sgk995upfe3tYLvoGcBN"
    return {
        "ready": key and bool(agent),
        "api_key_set": key,
        "agent_id": agent or None,
        "voice_id": voice,
        "model": getattr(cfg.voice, "elevenlabs_model", "") or "eleven_flash_v2_5",
    }


def ensure_convai_agent(cfg) -> str:
    """Return agent id; create Nexy agent on first run if missing."""
    existing = resolve_agent_id(cfg)
    if existing:
        return existing
    api_key = _api_key(cfg)
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")
    voice_id = getattr(cfg.voice, "elevenlabs_voice_id", "") or "sgk995upfe3tYLvoGcBN"
    # ConvAI English agents require turbo/flash v2 family (not v2_5 label in agent config).
    tts_model = "eleven_flash_v2"
    if "turbo" in (getattr(cfg.voice, "elevenlabs_model", "") or "").lower():
        tts_model = "eleven_turbo_v2"
    payload = {
        "name": "Nexy Dix01 (personal)",
        "conversation_config": {
            "agent": {
                "first_message": "",
                "language": "en",
                "prompt": {"prompt": NEXY_PROMPT},
            },
            "tts": {
                "voice_id": voice_id,
                "model_id": tts_model,
            },
        },
    }
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            "https://api.elevenlabs.io/v1/convai/agents/create",
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json=payload,
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"convai agent create HTTP {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    agent_id = str(body.get("agent_id") or "").strip()
    if not agent_id:
        raise RuntimeError("convai agent create returned no agent_id")
    save_stored_agent_id(cfg, agent_id)
    log.info("ConvAI agent created agent_id=%s voice=%s", agent_id, voice_id)
    return agent_id


def fetch_conversation_token(cfg, agent_id: str | None = None) -> str:
    api_key = _api_key(cfg)
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")
    aid = agent_id or ensure_convai_agent(cfg)
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(
            "https://api.elevenlabs.io/v1/convai/conversation/token",
            params={"agent_id": aid},
            headers={"xi-api-key": api_key},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"convai token HTTP {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    token = str(body.get("token") or "").strip()
    if not token:
        raise RuntimeError("convai token response missing token")
    return token


def probe_elevenlabs(cfg) -> dict[str, Any]:
    """Live HTTP probe — exact status codes for Ryan diagnostics (not the WebRTC data-channel)."""
    api_key = _api_key(cfg)
    aid = resolve_agent_id(cfg) or None
    out: dict[str, Any] = {
        "api_key_set": bool(api_key),
        "agent_id": aid,
        "checks": {},
    }
    if not api_key:
        out["ready"] = False
        return out

    with httpx.Client(timeout=30.0) as client:
        headers = {"xi-api-key": api_key}

        if aid:
            agent_url = f"https://api.elevenlabs.io/v1/convai/agents/{aid}"
            r_agent = client.get(agent_url, headers=headers)
            body_preview = (r_agent.text or "")[:400]
            out["checks"]["agent_get"] = {
                "url": agent_url,
                "http_status": r_agent.status_code,
                "ok": r_agent.is_success,
                "body_preview": body_preview,
            }
            if r_agent.is_success:
                try:
                    agent_body = r_agent.json()
                    cc = agent_body.get("conversation_config") or {}
                    out["checks"]["agent_get"]["tts_model_id"] = (cc.get("tts") or {}).get("model_id")
                    out["checks"]["agent_get"]["language"] = (cc.get("agent") or {}).get("language")
                except json.JSONDecodeError:
                    pass

            token_url = "https://api.elevenlabs.io/v1/convai/conversation/token"
            r_token = client.get(token_url, params={"agent_id": aid}, headers=headers)
            token_preview = ""
            if r_token.is_success:
                try:
                    tok = str(r_token.json().get("token") or "")
                    token_preview = f"len={len(tok)} prefix={tok[:24]}…" if tok else "empty"
                except json.JSONDecodeError:
                    token_preview = "invalid-json"
            else:
                token_preview = (r_token.text or "")[:200]
            out["checks"]["conversation_token"] = {
                "url": token_url,
                "http_status": r_token.status_code,
                "ok": r_token.is_success,
                "detail": token_preview,
            }

            signed_url = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
            r_signed = client.get(signed_url, params={"agent_id": aid}, headers=headers)
            signed_preview = ""
            if r_signed.is_success:
                try:
                    su = str(r_signed.json().get("signed_url") or "")
                    signed_preview = f"len={len(su)}" if su else "empty"
                except json.JSONDecodeError:
                    signed_preview = "invalid-json"
            else:
                signed_preview = (r_signed.text or "")[:200]
            out["checks"]["signed_url"] = {
                "url": signed_url,
                "http_status": r_signed.status_code,
                "ok": r_signed.is_success,
                "detail": signed_preview,
            }
        else:
            out["checks"]["agent_get"] = {"skipped": "no agent_id"}

    out["ready"] = all(
        c.get("ok") is True
        for k, c in out["checks"].items()
        if k in ("agent_get", "conversation_token", "signed_url")
    )
    return out


def fetch_signed_url(cfg, agent_id: str | None = None) -> str:
    api_key = _api_key(cfg)
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")
    aid = agent_id or ensure_convai_agent(cfg)
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(
            "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url",
            params={"agent_id": aid},
            headers={"xi-api-key": api_key},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"convai signed-url HTTP {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    url = str(body.get("signed_url") or "").strip()
    if not url:
        raise RuntimeError("convai signed_url missing")
    return url
