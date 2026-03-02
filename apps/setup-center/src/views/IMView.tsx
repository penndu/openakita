// ─── IMView: IM Channel Viewer (read-only) ───

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  IconIM, IconMessageCircle, IconRefresh, IconFile, IconImage, IconVolume,
  DotGreen, DotGray,
} from "../icons";

type IMChannel = {
  channel: string;
  name: string;
  status: "online" | "offline";
  sessionCount: number;
  lastActive: string | null;
};

type IMSession = {
  sessionId: string;
  channel: string;
  chatId: string | null;
  userId: string | null;
  state: string;
  lastActive: string;
  messageCount: number;
  lastMessage: string | null;
};

type ChainSummaryItem = {
  iteration: number;
  thinking_preview: string;
  thinking_duration_ms: number;
  tools: { name: string; input_preview: string }[];
  context_compressed?: {
    before_tokens: number;
    after_tokens: number;
  };
};

type IMMessage = {
  role: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown> | null;
  chain_summary?: ChainSummaryItem[] | null;
};

const API_BASE = "http://127.0.0.1:18900";

export function IMView({ serviceRunning }: { serviceRunning: boolean }) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<IMChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [sessions, setSessions] = useState<IMSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<IMMessage[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(false);

  const getChannelDisplayName = useCallback((ch: IMChannel): string => {
    const key = `status.${(ch.channel || "").toLowerCase()}`;
    const translated = t(key);
    // i18next returns key itself when translation is missing
    return translated && translated !== key ? translated : (ch.name || ch.channel);
  }, [t]);

  const fetchChannels = useCallback(async () => {
    if (!serviceRunning) return;
    try {
      const res = await fetch(`${API_BASE}/api/im/channels`);
      if (res.ok) {
        const data = await res.json();
        setChannels(data.channels || []);
      }
    } catch { /* ignore */ }
  }, [serviceRunning]);

  const fetchSessions = useCallback(async (channel: string): Promise<IMSession[]> => {
    if (!serviceRunning) return [];
    try {
      const res = await fetch(`${API_BASE}/api/im/sessions?channel=${encodeURIComponent(channel)}`);
      if (res.ok) {
        const data = await res.json();
        const list: IMSession[] = data.sessions || [];
        setSessions(list);
        return list;
      }
    } catch { /* ignore */ }
    return [];
  }, [serviceRunning]);

  const fetchMessages = useCallback(async (sessionId: string, limit = 50, offset = 0) => {
    if (!serviceRunning) return;
    try {
      const res = await fetch(`${API_BASE}/api/im/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
        setTotalMessages(data.total || 0);
      }
    } catch { /* ignore */ }
  }, [serviceRunning]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  // Auto-refresh: channels every 15s, active session messages every 8s
  useEffect(() => {
    if (!serviceRunning) return;
    const channelTimer = setInterval(() => {
      fetchChannels();
      if (selectedChannel) fetchSessions(selectedChannel);
    }, 15000);
    return () => clearInterval(channelTimer);
  }, [serviceRunning, selectedChannel, fetchChannels, fetchSessions]);

  useEffect(() => {
    if (!serviceRunning || !selectedSessionId) return;
    // 选中 session 后立即刷新一次，然后每 8 秒轮询
    fetchMessages(selectedSessionId);
    const msgTimer = setInterval(() => {
      fetchMessages(selectedSessionId);
    }, 8000);
    return () => clearInterval(msgTimer);
  }, [serviceRunning, selectedSessionId, fetchMessages]);

  const handleSelectChannel = useCallback(async (ch: string) => {
    setSelectedChannel(ch);
    setSelectedSessionId(null);
    setMessages([]);
    const list = await fetchSessions(ch);
    // 自动选中第一个 session，直接展示消息（无需再点一次）
    if (list.length > 0) {
      const first = list[0];
      setSelectedSessionId(first.sessionId);
      fetchMessages(first.sessionId);
    }
  }, [fetchSessions, fetchMessages]);

  const handleSelectSession = useCallback((sid: string) => {
    setSelectedSessionId(sid);
    fetchMessages(sid);
  }, [fetchMessages]);

  if (!serviceRunning) {
    return (
      <div className="imViewEmpty">
        <IconIM size={48} />
        <div style={{ marginTop: 12, fontWeight: 600 }}>{t("im.channels")}</div>
        <div style={{ marginTop: 4, opacity: 0.5, fontSize: 13 }}>{t("topbar.stopped")}</div>
      </div>
    );
  }

  return (
    <div className="imView">
      {/* Left panel: channels + sessions */}
      <div className="imLeft">
        <div className="imSectionTitle">
          <span>{t("im.channels")}</span>
          <button className="imRefreshBtn" onClick={fetchChannels} title={t("topbar.refresh")}><IconRefresh size={13} /></button>
        </div>
        <div className="imChannelList">
          {channels.length === 0 && (
            <div className="imEmptyHint">{t("im.noChannels")}</div>
          )}
          {channels.map((ch) => (
            <div
              key={ch.channel}
              className={`imChannelItem ${selectedChannel === ch.channel ? "imChannelItemActive" : ""}`}
              onClick={() => handleSelectChannel(ch.channel)}
              role="button"
              tabIndex={0}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {ch.status === "online" ? <DotGreen /> : <DotGray />}
                <span className="imChannelName">{getChannelDisplayName(ch)}</span>
              </div>
              <span className="imChannelCount">{ch.sessionCount}</span>
            </div>
          ))}
        </div>

        {selectedChannel && (
          <>
            <div className="imSectionTitle" style={{ marginTop: 8 }}>
              <span>{t("im.sessions")}</span>
            </div>
            <div className="imSessionList">
              {sessions.length === 0 && (
                <div className="imEmptyHint">{t("im.noSessions")}</div>
              )}
              {sessions.map((s) => (
                <div
                  key={s.sessionId}
                  className={`imSessionItem ${selectedSessionId === s.sessionId ? "imSessionItemActive" : ""}`}
                  onClick={() => handleSelectSession(s.sessionId)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="imSessionId">{s.userId || s.chatId || s.sessionId.slice(0, 12)}</div>
                  <div className="imSessionMeta">
                    {s.messageCount} {t("im.messages")} · {s.lastActive ? new Date(s.lastActive).toLocaleTimeString() : ""}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Right panel: messages */}
      <div className="imRight">
        {!selectedSessionId ? (
          <div className="imViewEmpty">
            <IconMessageCircle size={40} />
            <div style={{ marginTop: 8, opacity: 0.5, fontSize: 13 }}>{t("im.noMessages")}</div>
          </div>
        ) : (
          <div className="imMessages">
            <div className="imMessagesHeader">
              <span>{t("im.messages")} ({totalMessages})</span>
            </div>
            <div className="imMessagesList">
              {messages.map((msg, idx) => (
                <div key={idx} className={`imMsg ${msg.role === "user" ? "imMsgUser" : "imMsgBot"}`}>
                  <div className="imMsgRole">
                    {msg.role === "user" ? t("im.user") : msg.role === "system" ? t("im.system") : t("im.bot")}
                    <span className="imMsgTime">{msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ""}</span>
                  </div>
                  {/* 思维链摘要 (bot 消息) */}
                  {msg.role !== "user" && msg.chain_summary && msg.chain_summary.length > 0 && (
                    <IMChainSummary chain={msg.chain_summary} />
                  )}
                  <div className="imMsgContent">
                    <MediaContent content={msg.content} />
                  </div>
                </div>
              ))}
              {messages.length === 0 && (
                <div className="imEmptyHint">{t("im.noMessages")}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Render media references in IM messages
function MediaContent({ content }: { content: string }) {
  // Simple heuristic: detect [图片: ...] or [语音转文字: ...] or [文件: ...] patterns
  const mediaPattern = /\[(图片|语音转文字|语音|文件|image|voice|file)[:\uff1a]\s*([^\]]*)\]/gi;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mediaPattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={lastIndex}>{content.slice(lastIndex, match.index)}</span>);
    }
    const type = match[1].toLowerCase();
    const ref = match[2];
    const isImage = type.includes("图片") || type === "image";
    const isVoice = type.includes("语音") || type === "voice";

    parts.push(
      <span key={match.index} className="imMediaCard">
        {isImage ? <IconImage size={14} /> : isVoice ? <IconVolume size={14} /> : <IconFile size={14} />}
        <span>{ref || match[0]}</span>
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(<span key={lastIndex}>{content.slice(lastIndex)}</span>);
  }

  return <>{parts.length > 0 ? parts : content}</>;
}

/** IM 思维链简化摘要组件 */
function IMChainSummary({ chain }: { chain: ChainSummaryItem[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="imChainSummary"
      onClick={() => setExpanded(v => !v)}
      style={{ cursor: "pointer" }}
    >
      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 2 }}>
        {t("chat.chainSummary")} ({chain.length})
        <span style={{ marginLeft: 4, fontSize: 10 }}>{expanded ? "▼" : "▶"}</span>
      </div>
      {expanded && chain.map((item, idx) => (
        <div key={idx} className="imChainGroup">
          {item.context_compressed && (
            <div className="imChainCompressedLine">
              {t("chat.contextCompressed", {
                before: Math.round(item.context_compressed.before_tokens / 1000),
                after: Math.round(item.context_compressed.after_tokens / 1000),
              })}
            </div>
          )}
          {item.thinking_preview && (
            <div className="imChainThinkingLine">
              {t("chat.thoughtFor", { seconds: (item.thinking_duration_ms / 1000).toFixed(1) })}
              {" — "}
              {item.thinking_preview}
            </div>
          )}
          {item.tools.map((tool, ti) => (
            <div key={ti} className="imChainToolLine">
              {tool.name}{tool.input_preview ? `: ${tool.input_preview}` : ""}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
