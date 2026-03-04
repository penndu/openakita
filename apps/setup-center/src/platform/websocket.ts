// ─── WebSocket Event Client ───
// Replaces Tauri listen() events in web mode.
// Auto-reconnects on disconnect with exponential backoff.

import { IS_WEB } from "./detect";
import { getAccessToken, isTokenExpiringSoon, refreshAccessToken } from "./auth";

export type WsEventHandler = (event: string, data: unknown) => void;

let _ws: WebSocket | null = null;
let _handlers: WsEventHandler[] = [];
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectDelay = 1000;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 120;
let _connected = false;
let _intentionallyClosed = false;

function getWsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const token = getAccessToken();
  const params = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}//${loc.host}/ws/events${params}`;
}

function _connect(): void {
  if (_ws) return;
  _intentionallyClosed = false;

  try {
    _ws = new WebSocket(getWsUrl());
  } catch {
    _scheduleReconnect();
    return;
  }

  _ws.onopen = () => {
    _connected = true;
    _reconnectDelay = 1000;
    _reconnectAttempts = 0;
  };

  _ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const event = msg.event as string;
      const data = msg.data;
      if (event === "ping") {
        _ws?.send("ping");
        return;
      }
      for (const handler of _handlers) {
        try {
          handler(event, data);
        } catch (e) {
          console.error("[WS] handler error:", e);
        }
      }
    } catch { /* ignore non-JSON */ }
  };

  _ws.onclose = () => {
    _ws = null;
    _connected = false;
    if (!_intentionallyClosed) {
      _scheduleReconnect();
    }
  };

  _ws.onerror = () => {
    _ws?.close();
  };
}

function _scheduleReconnect(): void {
  if (_reconnectTimer || _intentionallyClosed) return;
  _reconnectAttempts++;
  if (_reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[WS] Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    return;
  }
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, 30000);
    const token = getAccessToken();
    if (!token || isTokenExpiringSoon(token, 60)) {
      await refreshAccessToken().catch(() => {});
    }
    _connect();
  }, _reconnectDelay);
}

/**
 * Subscribe to all WebSocket events. Returns unsubscribe function.
 * In Tauri mode this is a no-op (Tauri events are used instead).
 */
export function onWsEvent(handler: WsEventHandler): () => void {
  if (!IS_WEB) return () => {};

  _handlers.push(handler);
  // Ensure connection is started
  if (!_ws && !_reconnectTimer) {
    _connect();
  }

  return () => {
    _handlers = _handlers.filter((h) => h !== handler);
    // If no more handlers, disconnect
    if (_handlers.length === 0) {
      disconnectWs();
    }
  };
}

export function disconnectWs(): void {
  _intentionallyClosed = true;
  _reconnectAttempts = 0;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _connected = false;
}

export function isWsConnected(): boolean {
  return _connected;
}
