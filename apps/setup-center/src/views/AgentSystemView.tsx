import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FieldText, FieldBool, FieldSelect } from "../components/EnvFields";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronDown, Brain, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { safeFetch } from "../providers";
import type { EnvMap } from "../types";
import { envGet, envSet } from "../utils";

// ─── Types ──────────────────────────────────────────────────────────────

type AgentSystemViewProps = {
  envDraft: EnvMap;
  setEnvDraft: (updater: (prev: EnvMap) => EnvMap) => void;
  busy?: string | null;
  disabledViews: string[];
  toggleViewDisabled: (viewName: string) => void;
  serviceRunning?: boolean;
  apiBaseUrl?: string;
};

// ─── Reusable: collapsible section ──────────────────────────────────────

function Section({ title, children, toggle, className }: {
  title: string;
  children?: React.ReactNode;
  toggle?: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={`group rounded-lg border border-border ${className ?? ""}`}>
      <summary className="cursor-pointer flex items-center justify-between px-4 py-2.5 text-sm font-medium select-none list-none [&::-webkit-details-marker]:hidden hover:bg-accent/50 transition-colors">
        <span className="flex items-center gap-1.5">
          {children ? (
            <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180 text-muted-foreground" />
          ) : (
            <span className="size-4 shrink-0" />
          )}
          {title}
        </span>
        {toggle}
      </summary>
      {children && (
        <div className="flex flex-col gap-2.5 px-4 py-3 border-t border-border">
          {children}
        </div>
      )}
    </details>
  );
}

// ─── Reusable: toggle pill (iOS-style switch in summary) ────────────────

function TogglePill({ enabled, label, onToggle }: {
  enabled: boolean;
  label: [string, string]; // [enabledText, disabledText]
  onToggle: () => void;
}) {
  return (
    <label
      className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"
      onClick={(e) => e.stopPropagation()}
    >
      <span>{enabled ? label[0] : label[1]}</span>
      <div
        onClick={onToggle}
        className="relative shrink-0 transition-colors duration-200 rounded-full"
        style={{
          width: 40, height: 22,
          background: enabled ? "var(--ok, #22c55e)" : "var(--line, #d1d5db)",
        }}
      >
        <div
          className="absolute top-0.5 rounded-full bg-white shadow-sm transition-[left] duration-200"
          style={{ width: 18, height: 18, left: enabled ? 20 : 2 }}
        />
      </div>
    </label>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────

export function AgentSystemView(props: AgentSystemViewProps) {
  const { envDraft, setEnvDraft, busy = null, disabledViews, toggleViewDisabled, serviceRunning, apiBaseUrl = "" } = props;
  const { t } = useTranslation();

  const [reviewing, setReviewing] = useState(false);
  const [showReviewConfirm, setShowReviewConfirm] = useState(false);

  const handleReview = async () => {
    setShowReviewConfirm(false);
    setReviewing(true);
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/memories/review`, {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
      });
      const data = await res.json();
      const review = data?.review ?? data;
      if (review && typeof review.deleted === "number") {
        toast.success(
          `LLM 审查完成：删除 ${review.deleted}，更新 ${review.updated}，合并 ${review.merged}，保留 ${review.kept}` +
          (review.errors > 0 ? `，错误 ${review.errors}` : "")
        );
      } else {
        toast.error("审查完成，但返回数据格式异常");
      }
    } catch (e: any) {
      toast.error(e.message || "审查请求失败");
    } finally {
      setReviewing(false);
    }
  };

  const _envBase = { envDraft, onEnvChange: setEnvDraft, busy };
  const FT = (p: { k: string; label: string; placeholder?: string; help?: string; type?: "text" | "password" }) =>
    <FieldText key={p.k} {...p} {..._envBase} />;
  const FB = (p: { k: string; label: string; help?: string; defaultValue?: boolean }) =>
    <FieldBool key={p.k} {...p} {..._envBase} />;
  const FS = (p: { k: string; label: string; options: { value: string; label: string }[]; help?: string }) =>
    <FieldSelect key={p.k} {...p} {..._envBase} />;

  const enabledLabel: [string, string] = [
    t("config.toolsSkillsEnabled"),
    t("config.toolsSkillsDisabled"),
  ];

  const proactiveEnabled = envGet(envDraft, "PROACTIVE_ENABLED", "true") !== "false";

  const personas = [
    { id: "default", desc: "config.agentPersonaDefault" },
    { id: "business", desc: "config.agentPersonaBusiness" },
    { id: "tech_expert", desc: "config.agentPersonaTech" },
    { id: "butler", desc: "config.agentPersonaButler" },
    { id: "girlfriend", desc: "config.agentPersonaGirlfriend" },
    { id: "boyfriend", desc: "config.agentPersonaBoyfriend" },
    { id: "family", desc: "config.agentPersonaFamily" },
    { id: "jarvis", desc: "config.agentPersonaJarvis" },
  ];
  const curPersona = envGet(envDraft, "PERSONA_NAME", "default");

  return (
    <>
      {/* ═══════ Card 1: Agent 配置 ═══════ */}
      <div className="card">
        <h3 className="text-base font-bold tracking-tight">{t("config.agentTitle")}</h3>
        <p className="text-sm text-muted-foreground mt-1 mb-3">{t("config.agentHint")}</p>

        {/* ── 角色选择 ── */}
        <Section title={t("config.agentPersona")}>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={2}
            value={curPersona}
            onValueChange={(val) => {
              if (val) setEnvDraft((m) => envSet(m, "PERSONA_NAME", val));
            }}
            className="flex-wrap"
          >
            {personas.map((p) => (
              <ToggleGroupItem
                key={p.id}
                value={p.id}
                className="text-sm min-w-[5.5rem] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
              >
                {t(p.desc)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {(curPersona === "custom" || !personas.find((p) => p.id === curPersona)) && (
            <Input
              className="max-w-[300px]"
              placeholder={t("config.agentCustomId")}
              value={envGet(envDraft, "PERSONA_NAME", "custom")}
              onChange={(e) => {
                setEnvDraft((m) => envSet(m, "PERSONA_NAME", e.target.value || "custom"));
              }}
            />
          )}
        </Section>

        {/* ── 核心参数 ── */}
        <Section title={t("config.agentCore")} className="mt-2">
          <div className="grid3">
            {FT({ k: "AGENT_NAME", label: t("config.agentName"), placeholder: "OpenAkita" })}
            {FT({ k: "MAX_ITERATIONS", label: t("config.agentMaxIter"), placeholder: "300", help: t("config.agentMaxIterHelp") })}
            {FS({ k: "THINKING_MODE", label: t("config.agentThinking"), options: [
              { value: "auto", label: "auto (自动判断)" },
              { value: "always", label: "always (始终思考)" },
              { value: "never", label: "never (从不思考)" },
            ] })}
          </div>
        </Section>

        {/* ── 活人感模式 ── */}
        <Section
          title={t("config.agentProactive")}
          className="mt-2"
          toggle={
            <TogglePill
              enabled={proactiveEnabled}
              label={enabledLabel}
              onToggle={() => setEnvDraft((p) => ({ ...p, PROACTIVE_ENABLED: proactiveEnabled ? "false" : "true" }))}
            />
          }
        >
          <div className="grid3">
            {FT({ k: "PROACTIVE_MAX_DAILY_MESSAGES", label: t("config.agentMaxDaily"), placeholder: "3", help: t("config.agentMaxDailyHelp") })}
            {FT({ k: "PROACTIVE_MIN_INTERVAL_MINUTES", label: t("config.agentMinInterval"), placeholder: "120", help: t("config.agentMinIntervalHelp") })}
            {FT({ k: "PROACTIVE_IDLE_THRESHOLD_HOURS", label: t("config.agentIdleThreshold"), placeholder: "24", help: t("config.agentIdleThresholdHelp") })}
          </div>
          <div className="grid3">
            {FT({ k: "PROACTIVE_QUIET_HOURS_START", label: t("config.agentQuietStart"), placeholder: "23", help: t("config.agentQuietStartHelp") })}
            {FT({ k: "PROACTIVE_QUIET_HOURS_END", label: t("config.agentQuietEnd"), placeholder: "7" })}
            <div />
          </div>
          <div className="grid3">
            {FB({ k: "STICKER_ENABLED", label: t("config.agentSticker"), help: t("config.agentStickerHelp") })}
            {FT({ k: "STICKER_DATA_DIR", label: t("config.agentStickerDir"), placeholder: "data/sticker" })}
            <div />
          </div>
        </Section>
      </div>

      {/* ═══════ Card 2: 计划与记忆 ═══════ */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="text-base font-bold tracking-tight mb-3">{t("config.agentPlanAndMemory")}</h3>

        {/* ── 计划任务 ── */}
        <Section
          title={t("config.agentScheduler")}
          toggle={
            <TogglePill
              enabled={!disabledViews.includes("scheduler")}
              label={enabledLabel}
              onToggle={() => toggleViewDisabled("scheduler")}
            />
          }
        >
          <div className="grid3">
            {FT({ k: "SCHEDULER_TIMEZONE", label: t("config.agentTimezone"), placeholder: "Asia/Shanghai", help: t("config.agentTimezoneHelp") })}
          </div>
        </Section>

        {/* ── 记忆管理 ── */}
        <Section
          title={t("sidebar.memory")}
          className="mt-2"
          toggle={
            <TogglePill
              enabled={!disabledViews.includes("memory")}
              label={enabledLabel}
              onToggle={() => toggleViewDisabled("memory")}
            />
          }
        >
          <Button
            size="sm"
            onClick={() => setShowReviewConfirm(true)}
            disabled={reviewing || !serviceRunning}
            className="bg-gradient-to-br from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white border-0 w-fit"
          >
            {reviewing ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
            {reviewing ? t("config.memoryReviewing") : t("config.memoryReviewBtn")}
          </Button>
        </Section>

        <AlertDialog open={showReviewConfirm} onOpenChange={setShowReviewConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("config.memoryReviewTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("config.memoryReviewDesc")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("config.memoryReviewCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleReview}
                className="bg-gradient-to-br from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white border-0"
              >
                {t("config.memoryReviewConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* ═══════ Card 3: 系统配置 ═══════ */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="text-base font-bold tracking-tight mb-3">{t("config.agentAdvanced")}</h3>

        {/* ── 桌面通知 ── */}
        <Section title={t("config.agentDesktopNotify")}>
          <div className="grid2">
            {FB({ k: "DESKTOP_NOTIFY_ENABLED", label: t("config.agentDesktopNotifyEnable"), help: t("config.agentDesktopNotifyEnableHelp") })}
            {FB({ k: "DESKTOP_NOTIFY_SOUND", label: t("config.agentDesktopNotifySound"), help: t("config.agentDesktopNotifySoundHelp") })}
          </div>
        </Section>

        {/* ── 会话配置 ── */}
        <Section title={t("config.agentSessionSection")} className="mt-2">
          <div className="grid3">
            {FT({ k: "SESSION_TIMEOUT_MINUTES", label: t("config.agentSessionTimeout"), placeholder: "30" })}
            {FT({ k: "SESSION_MAX_HISTORY", label: t("config.agentSessionMax"), placeholder: "50" })}
            {FT({ k: "SESSION_STORAGE_PATH", label: t("config.agentSessionPath"), placeholder: "data/sessions" })}
          </div>
        </Section>

        {/* ── 日志配置 ── */}
        <Section title={t("config.agentLogSection")} className="mt-2">
          <div className="grid3">
            {FS({ k: "LOG_LEVEL", label: t("config.agentLogLevel"), options: [
              { value: "DEBUG", label: "DEBUG" },
              { value: "INFO", label: "INFO" },
              { value: "WARNING", label: "WARNING" },
              { value: "ERROR", label: "ERROR" },
            ] })}
            {FT({ k: "LOG_DIR", label: t("config.agentLogDir"), placeholder: "logs" })}
            {FT({ k: "DATABASE_PATH", label: t("config.agentDbPath"), placeholder: "data/agent.db" })}
          </div>
          <div className="grid3">
            {FT({ k: "LOG_MAX_SIZE_MB", label: t("config.agentLogMaxMB"), placeholder: "10" })}
            {FT({ k: "LOG_BACKUP_COUNT", label: t("config.agentLogBackup"), placeholder: "30" })}
            {FT({ k: "LOG_RETENTION_DAYS", label: t("config.agentLogRetention"), placeholder: "30" })}
          </div>
          <div className="grid2">
            {FB({ k: "LOG_TO_CONSOLE", label: t("config.agentLogConsole") })}
            {FB({ k: "LOG_TO_FILE", label: t("config.agentLogFile") })}
          </div>
        </Section>
      </div>
    </>
  );
}
