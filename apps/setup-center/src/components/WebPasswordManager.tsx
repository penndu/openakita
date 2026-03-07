import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { safeFetch } from "../providers";
import { copyToClipboard } from "../utils/clipboard";

export function WebPasswordManager({
  apiBase,
  busy,
  setBusy,
  setNotice,
  setError,
}: {
  apiBase: string;
  busy: string | null;
  setBusy: (v: string | null) => void;
  setNotice: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const [hint, setHint] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");
  const [showNew, setShowNew] = useState(false);

  const loadHint = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBase}/api/auth/password-hint`);
      const data = await res.json();
      setHint(data.hint || "—");
    } catch {
      setHint(null);
    }
  }, [apiBase]);

  useEffect(() => { loadHint(); }, [loadHint]);

  const doChangePassword = async (password: string) => {
    setBusy(t("common.loading"));
    try {
      await safeFetch(`${apiBase}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: password }),
      });
      setNotice(t("adv.webPasswordChanged"));
      setNewPw("");
      await loadHint();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const [generatedPw, setGeneratedPw] = useState<string | null>(null);

  const doRandomize = async () => {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let pw = "";
    for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    await doChangePassword(pw);
    setGeneratedPw(pw);
    await copyToClipboard(pw);
    setNotice(t("adv.webPasswordReset", { password: pw }));
  };

  const copyGenerated = async () => {
    if (!generatedPw) return;
    const ok = await copyToClipboard(generatedPw);
    if (ok) setNotice(t("adv.webPasswordCopied", { defaultValue: "密码已复制到剪贴板" }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {hint !== null && (
        <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--muted)", minWidth: 80 }}>{t("adv.webPasswordCurrent")}:</span>
          <code style={{ padding: "2px 8px", background: "var(--bg)", borderRadius: 4, fontSize: 13, letterSpacing: 1 }}>{hint}</code>
        </div>
      )}
      {generatedPw && (
        <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--success-bg, #f0fdf4)", borderRadius: 6, border: "1px solid var(--success-line, #bbf7d0)" }}>
          <span style={{ color: "var(--success, #16a34a)", fontWeight: 500, whiteSpace: "nowrap" }}>{t("adv.webPasswordGenerated", { defaultValue: "新密码" })}:</span>
          <code style={{ flex: 1, padding: "2px 6px", background: "var(--bg)", borderRadius: 4, fontSize: 13, letterSpacing: 0.5, userSelect: "all", wordBreak: "break-all" }}>{generatedPw}</code>
          <button className="btnSmall" onClick={copyGenerated} style={{ fontSize: 12, whiteSpace: "nowrap" }}>
            {t("common.copy", { defaultValue: "复制" })}
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type={showNew ? "text" : "password"}
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          placeholder={t("adv.webPasswordNewPlaceholder")}
          style={{ flex: 1, minWidth: 160, fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--fg)" }}
        />
        <button className="btnSmall" onClick={() => setShowNew((v) => !v)} style={{ fontSize: 12 }}>
          {showNew ? "🙈" : "👁"}
        </button>
        <button
          className="btnSmall btnSmallPrimary"
          onClick={() => { if (newPw.trim()) doChangePassword(newPw.trim()); }}
          disabled={!newPw.trim() || !!busy}
        >
          {t("adv.webPasswordSet")}
        </button>
        <button className="btnSmall" onClick={doRandomize} disabled={!!busy}>
          {t("adv.webPasswordRandomize")}
        </button>
      </div>
    </div>
  );
}
