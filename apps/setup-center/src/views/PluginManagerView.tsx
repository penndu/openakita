import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { safeFetch } from "../providers";
import { IconCode, IconPlug, IconFileText2, IconPackage, IconBook, IconGear } from "../icons";

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  type: string;
  category: string;
  permissions?: string[];
  permission_level?: string;
  enabled?: boolean;
  status?: string;
  error?: string;
  description?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
  has_readme?: boolean;
  has_config_schema?: boolean;
}

interface PluginListResponse {
  plugins: PluginInfo[];
  failed: Record<string, string>;
}

interface ConfigSchema {
  type?: string;
  properties?: Record<string, {
    type?: string;
    description?: string;
    default?: any;
    enum?: string[];
    items?: { type?: string };
  }>;
  required?: string[];
}

const LEVEL_COLORS: Record<string, string> = {
  basic: "var(--ok, #22c55e)",
  advanced: "var(--warning, #f59e0b)",
  system: "var(--danger, #ef4444)",
};

function TypeIcon({ type }: { type: string }) {
  const style = { flexShrink: 0, color: "var(--muted)" } as const;
  switch (type) {
    case "python": return <IconCode size={18} style={style} />;
    case "mcp":    return <IconPlug size={18} style={style} />;
    case "skill":  return <IconFileText2 size={18} style={style} />;
    default:       return <IconPackage size={18} style={style} />;
  }
}

interface Props {
  visible: boolean;
  httpApiBase: () => string;
}

export default function PluginManagerView({ visible, httpApiBase }: Props) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notAvailable, setNotAvailable] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [readmeCache, setReadmeCache] = useState<Record<string, string>>({});
  const [configPanel, setConfigPanel] = useState<string | null>(null);
  const [configSchema, setConfigSchema] = useState<ConfigSchema | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, any>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [configMsg, setConfigMsg] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    setNotAvailable(false);
    try {
      const resp = await safeFetch(`${httpApiBase()}/api/plugins/list`);
      const data: PluginListResponse = await resp.json();
      setPlugins(data.plugins || []);
      setFailed(data.failed || {});
    } catch (e: any) {
      const msg = e.message || "";
      if (msg.includes("404") || msg.includes("Not Found") || msg.includes("Failed to fetch")) {
        setNotAvailable(true);
      } else {
        setError(msg || t("plugins.failedToLoad"));
      }
    } finally {
      setLoading(false);
    }
  }, [t, httpApiBase]);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const handleAction = async (id: string, action: "enable" | "disable" | "delete") => {
    try {
      const method = action === "delete" ? "DELETE" : "POST";
      const url =
        action === "delete"
          ? `${httpApiBase()}/api/plugins/${id}`
          : `${httpApiBase()}/api/plugins/${id}/${action}`;
      await safeFetch(url, { method });
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleInstall = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    setError("");
    try {
      await safeFetch(`${httpApiBase()}/api/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: installUrl.trim() }),
      });
      setInstallUrl("");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInstalling(false);
    }
  };

  const toggleReadme = async (pluginId: string) => {
    if (expandedId === pluginId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(pluginId);
    if (!readmeCache[pluginId]) {
      try {
        const resp = await safeFetch(`${httpApiBase()}/api/plugins/${pluginId}/readme`);
        const data = await resp.json();
        setReadmeCache((prev) => ({ ...prev, [pluginId]: data.readme || t("plugins.noReadme") }));
      } catch {
        setReadmeCache((prev) => ({ ...prev, [pluginId]: t("plugins.readmeLoadFail") }));
      }
    }
  };

  const openConfig = async (pluginId: string) => {
    if (configPanel === pluginId) {
      setConfigPanel(null);
      return;
    }
    setConfigPanel(pluginId);
    setConfigMsg("");
    try {
      const [schemaResp, configResp] = await Promise.all([
        safeFetch(`${httpApiBase()}/api/plugins/${pluginId}/schema`),
        safeFetch(`${httpApiBase()}/api/plugins/${pluginId}/config`),
      ]);
      const schemaData = await schemaResp.json();
      const configData = await configResp.json();
      setConfigSchema(schemaData.schema || null);
      setConfigValues(configData || {});
    } catch {
      setConfigSchema(null);
      setConfigValues({});
      setConfigMsg(t("plugins.configLoadFail"));
    }
  };

  const saveConfig = async (pluginId: string) => {
    setConfigSaving(true);
    setConfigMsg("");
    try {
      await safeFetch(`${httpApiBase()}/api/plugins/${pluginId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configValues),
      });
      setConfigMsg(t("plugins.configSaved"));
    } catch (e: any) {
      setConfigMsg(e.message || t("plugins.configSaveFail"));
    } finally {
      setConfigSaving(false);
    }
  };

  const installBtnDisabled = installing || !installUrl.trim() || notAvailable;

  if (!visible) return null;

  return (
    <div style={{ padding: "24px", maxWidth: 900 }}>
      <h2 style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, color: "var(--fg)" }}>
        {t("plugins.title")}
        <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 400 }}>
          {t("plugins.installed", { count: plugins.length })}
        </span>
      </h2>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 20 }}>
        {t("plugins.desc")}
      </p>

      {/* Install bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          type="text"
          placeholder={t("plugins.installPlaceholder")}
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !installBtnDisabled && handleInstall()}
          disabled={notAvailable}
          style={{
            flex: 1,
            padding: "8px 12px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "var(--bg-subtle, var(--panel))",
            color: "var(--fg)",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          onClick={handleInstall}
          disabled={installBtnDisabled}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            background: installBtnDisabled ? "var(--muted, #9ca3af)" : "var(--primary, #2563eb)",
            color: "#fff",
            cursor: installBtnDisabled ? "not-allowed" : "pointer",
            fontSize: 13,
            opacity: installBtnDisabled ? 0.5 : 1,
            transition: "background 0.2s, opacity 0.2s",
          }}
        >
          {installing ? t("plugins.installing") : t("plugins.install")}
        </button>
        <button
          onClick={refresh}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid var(--line)",
            background: "transparent",
            color: "var(--muted)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {t("plugins.refresh")}
        </button>
      </div>

      {notAvailable && (
        <div style={{
          padding: "14px 18px",
          background: "var(--warn-bg, rgba(245, 158, 11, 0.15))",
          border: "1px solid var(--warning, #f59e0b)",
          borderRadius: 6,
          color: "var(--fg)",
          marginBottom: 16,
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          {t("plugins.notAvailable")}
        </div>
      )}

      {error && (
        <div style={{
          padding: "10px 14px",
          background: "var(--err-bg, rgba(239, 68, 68, 0.15))",
          border: "1px solid var(--danger, #ef4444)",
          borderRadius: 6,
          color: "var(--error, #f87171)",
          marginBottom: 16,
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {loading && !notAvailable ? (
        <div style={{ color: "var(--muted)", padding: 40, textAlign: "center" }}>
          {t("plugins.loading")}
        </div>
      ) : !notAvailable && plugins.length === 0 && Object.keys(failed).length === 0 ? (
        <div style={{ color: "var(--muted)", padding: 40, textAlign: "center" }}>
          {t("plugins.noPlugins")}
        </div>
      ) : !notAvailable ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plugins.map((p) => (
            <div
              key={p.id}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "14px 18px",
                background: "var(--card-bg, var(--panel))",
              }}
            >
              {/* Header row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                  <TypeIcon type={p.type} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg)", display: "flex", alignItems: "center", gap: 6 }}>
                      {p.name}
                      {p.permission_level && (
                        <span
                          style={{
                            display: "inline-block",
                            padding: "1px 6px",
                            borderRadius: 10,
                            fontSize: 10,
                            fontWeight: 600,
                            color: "#fff",
                            background: LEVEL_COLORS[p.permission_level] || "var(--muted)",
                          }}
                        >
                          {p.permission_level}
                        </span>
                      )}
                    </div>
                    <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2 }}>
                      v{p.version} · {p.category || p.type}
                      {p.author ? ` · ${p.author}` : ""}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  {p.status === "failed" && (
                    <span style={{ color: "var(--error, #f87171)", fontSize: 11 }}>{t("plugins.failed")}</span>
                  )}
                  {p.has_readme && (
                    <button
                      onClick={() => toggleReadme(p.id)}
                      title={t("plugins.viewDocs")}
                      style={{
                        padding: "4px 8px", borderRadius: 4, display: "inline-flex", alignItems: "center",
                        border: "1px solid var(--line)", background: expandedId === p.id ? "var(--bg-subtle, var(--panel2))" : "transparent",
                        color: "var(--muted)", cursor: "pointer",
                      }}
                    >
                      <IconBook size={14} />
                    </button>
                  )}
                  {p.has_config_schema && (
                    <button
                      onClick={() => openConfig(p.id)}
                      title={t("plugins.settings")}
                      style={{
                        padding: "4px 8px", borderRadius: 4, display: "inline-flex", alignItems: "center",
                        border: "1px solid var(--line)", background: configPanel === p.id ? "var(--bg-subtle, var(--panel2))" : "transparent",
                        color: "var(--muted)", cursor: "pointer",
                      }}
                    >
                      <IconGear size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => handleAction(p.id, p.enabled === false ? "enable" : "disable")}
                    style={{
                      padding: "4px 10px", borderRadius: 4,
                      border: "1px solid var(--line)", background: "transparent",
                      color: p.enabled === false ? "var(--ok, #22c55e)" : "var(--muted)",
                      cursor: "pointer", fontSize: 12,
                    }}
                  >
                    {p.enabled === false ? t("plugins.enable") : t("plugins.disable")}
                  </button>
                  <button
                    onClick={() => handleAction(p.id, "delete")}
                    style={{
                      padding: "4px 10px", borderRadius: 4,
                      border: "1px solid var(--danger, #ef4444)", background: "transparent",
                      color: "var(--error, #f87171)", cursor: "pointer", fontSize: 12,
                    }}
                  >
                    {t("plugins.remove")}
                  </button>
                </div>
              </div>

              {/* Description */}
              {p.description && (
                <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
                  {p.description}
                </div>
              )}

              {/* Tags */}
              {(p.tags?.length ?? 0) > 0 && (
                <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {(p.tags || []).map((tag) => (
                    <span key={tag} style={{
                      padding: "1px 6px", borderRadius: 4, fontSize: 10,
                      background: "var(--bg-subtle, var(--panel2))", color: "var(--muted)",
                      border: "1px solid var(--line)",
                    }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Error */}
              {p.error && (
                <div style={{ marginTop: 6, color: "var(--error, #f87171)", fontSize: 12 }}>{p.error}</div>
              )}

              {/* README panel */}
              {expandedId === p.id && (
                <div style={{
                  marginTop: 10, padding: "12px 16px", borderRadius: 6,
                  background: "var(--bg-subtle, var(--panel2))", border: "1px solid var(--line)",
                  fontSize: 13, lineHeight: 1.6, color: "var(--fg)",
                  maxHeight: 400, overflowY: "auto",
                  whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, monospace)",
                }}>
                  {readmeCache[p.id] || t("plugins.loading")}
                </div>
              )}

              {/* Config panel */}
              {configPanel === p.id && (
                <div style={{
                  marginTop: 10, padding: "14px 16px", borderRadius: 6,
                  background: "var(--bg-subtle, var(--panel2))", border: "1px solid var(--line)",
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)", marginBottom: 10 }}>
                    {t("plugins.settings")}
                  </div>
                  {configSchema?.properties ? (
                    <>
                      {Object.entries(configSchema.properties).map(([key, prop]) => {
                        const isRequired = configSchema.required?.includes(key);
                        return (
                          <div key={key} style={{ marginBottom: 12 }}>
                            <label style={{ display: "block", fontSize: 12, color: "var(--fg)", marginBottom: 4, fontWeight: 500 }}>
                              {key}
                              {isRequired && <span style={{ color: "var(--danger, #ef4444)", marginLeft: 2 }}>*</span>}
                            </label>
                            {prop.description && (
                              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                                {prop.description}
                              </div>
                            )}
                            {prop.enum ? (
                              <select
                                value={configValues[key] ?? prop.default ?? ""}
                                onChange={(e) => setConfigValues((v) => ({ ...v, [key]: e.target.value }))}
                                style={{
                                  width: "100%", padding: "6px 10px", borderRadius: 4,
                                  border: "1px solid var(--line)", background: "var(--bg, #fff)",
                                  color: "var(--fg)", fontSize: 13,
                                }}
                              >
                                <option value="">--</option>
                                {prop.enum.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                              </select>
                            ) : prop.type === "boolean" ? (
                              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--fg)" }}>
                                <input
                                  type="checkbox"
                                  checked={!!configValues[key]}
                                  onChange={(e) => setConfigValues((v) => ({ ...v, [key]: e.target.checked }))}
                                />
                                {key}
                              </label>
                            ) : prop.type === "integer" || prop.type === "number" ? (
                              <input
                                type="number"
                                value={configValues[key] ?? prop.default ?? ""}
                                onChange={(e) => setConfigValues((v) => ({ ...v, [key]: Number(e.target.value) }))}
                                style={{
                                  width: "100%", padding: "6px 10px", borderRadius: 4,
                                  border: "1px solid var(--line)", background: "var(--bg, #fff)",
                                  color: "var(--fg)", fontSize: 13,
                                }}
                              />
                            ) : prop.type === "array" ? (
                              <input
                                type="text"
                                placeholder={t("plugins.arrayHint")}
                                value={Array.isArray(configValues[key]) ? configValues[key].join(", ") : (configValues[key] ?? "")}
                                onChange={(e) => setConfigValues((v) => ({
                                  ...v,
                                  [key]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                                }))}
                                style={{
                                  width: "100%", padding: "6px 10px", borderRadius: 4,
                                  border: "1px solid var(--line)", background: "var(--bg, #fff)",
                                  color: "var(--fg)", fontSize: 13,
                                }}
                              />
                            ) : (
                              <input
                                type={key.toLowerCase().includes("password") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("key") ? "password" : "text"}
                                value={configValues[key] ?? prop.default ?? ""}
                                placeholder={prop.default != null ? String(prop.default) : ""}
                                onChange={(e) => setConfigValues((v) => ({ ...v, [key]: e.target.value }))}
                                style={{
                                  width: "100%", padding: "6px 10px", borderRadius: 4,
                                  border: "1px solid var(--line)", background: "var(--bg, #fff)",
                                  color: "var(--fg)", fontSize: 13,
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                        <button
                          onClick={() => saveConfig(p.id)}
                          disabled={configSaving}
                          style={{
                            padding: "6px 16px", borderRadius: 4, border: "none",
                            background: "var(--primary, #2563eb)", color: "#fff",
                            cursor: configSaving ? "not-allowed" : "pointer", fontSize: 12,
                            opacity: configSaving ? 0.6 : 1,
                          }}
                        >
                          {configSaving ? t("plugins.saving") : t("plugins.saveConfig")}
                        </button>
                        {configMsg && (
                          <span style={{
                            fontSize: 12,
                            color: configMsg === t("plugins.configSaved") ? "var(--ok, #22c55e)" : "var(--error, #f87171)",
                          }}>
                            {configMsg}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      {t("plugins.noConfigSchema")}
                      <pre style={{
                        marginTop: 8, padding: 10, borderRadius: 4,
                        background: "var(--bg, #fff)", border: "1px solid var(--line)",
                        fontSize: 12, whiteSpace: "pre-wrap", color: "var(--fg)",
                      }}>
                        {JSON.stringify(configValues, null, 2) || "{}"}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {Object.keys(failed).length > 0 && (
            <>
              <h3 style={{ marginTop: 16, color: "var(--error, #f87171)", fontSize: 14 }}>
                {t("plugins.failedToLoad")}
              </h3>
              {Object.entries(failed).map(([id, reason]) => (
                <div
                  key={id}
                  style={{
                    border: "1px solid var(--danger, #ef4444)",
                    borderRadius: 8,
                    padding: "10px 14px",
                    background: "var(--err-bg, rgba(239, 68, 68, 0.15))",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>{id}</div>
                  <div style={{ color: "var(--error, #f87171)", fontSize: 12, marginTop: 4 }}>{reason}</div>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
