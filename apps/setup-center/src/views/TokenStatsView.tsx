// ─── TokenStatsView: Token 用量统计面板 ───
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { safeFetch } from "../providers";
import { IconStatus } from "../icons";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "../components/ui/table";

type PeriodKey = "1d" | "3d" | "1w" | "1m" | "6m" | "1y";

type SummaryRow = {
  group_key: string;
  total_input: number;
  total_output: number;
  total_tokens: number;
  total_cache_creation: number;
  total_cache_read: number;
  request_count: number;
  total_cost: number;
};

type TimelineRow = {
  time_bucket: string;
  total_input: number;
  total_output: number;
  total_tokens: number;
  request_count: number;
};

type TotalRow = {
  total_input: number;
  total_output: number;
  total_tokens: number;
  total_cache_creation: number;
  total_cache_read: number;
  request_count: number;
  total_cost: number;
};

type SessionRow = {
  session_id: string;
  first_call: string;
  last_call: string;
  total_input: number;
  total_output: number;
  total_tokens: number;
  request_count: number;
  operation_types: string;
  endpoints: string;
  total_cost: number;
};

const PERIOD_KEYS: PeriodKey[] = ["1d", "3d", "1w", "1m", "6m", "1y"];
const PERIOD_I18N: Record<PeriodKey, string> = {
  "1d": "tokenStats.period1d",
  "3d": "tokenStats.period3d",
  "1w": "tokenStats.period1w",
  "1m": "tokenStats.period1m",
  "6m": "tokenStats.period6m",
  "1y": "tokenStats.period1y",
};

function utcToLocal(utcStr: string): string {
  if (!utcStr || utcStr.length <= 10) return utcStr;
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return utcStr;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  if (!n || n === 0) return "-";
  if (n >= 1) return `¥${n.toFixed(2)}`;
  if (n >= 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(6)}`;
}

function MiniBar({ value, max, color = "hsl(var(--primary))" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(value / max, 1) * 100 : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

const STAT_COLORS = ["hsl(var(--primary))", "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b"];

export function TokenStatsView({
  serviceRunning,
  apiBaseUrl = "http://127.0.0.1:18900",
  disabled = false,
  onToggleDisabled,
}: {
  serviceRunning: boolean;
  apiBaseUrl?: string;
  disabled?: boolean;
  onToggleDisabled?: () => void;
}) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<PeriodKey>("1d");
  const [total, setTotal] = useState<TotalRow | null>(null);
  const [byEndpoint, setByEndpoint] = useState<SummaryRow[]>([]);
  const [byOp, setByOp] = useState<SummaryRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [fetchError, setFetchError] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const base = `${apiBaseUrl}/api/stats/tokens`;
      const results = await Promise.allSettled([
        safeFetch(`${base}/total?period=${period}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
        safeFetch(`${base}/summary?period=${period}&group_by=endpoint_name`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
        safeFetch(`${base}/summary?period=${period}&group_by=operation_type`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
        safeFetch(`${base}/timeline?period=${period}&interval=${period === "1d" ? "hour" : "day"}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
        safeFetch(`${base}/sessions?period=${period}&limit=20`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      ]);
      const val = (i: number) => results[i].status === "fulfilled" ? (results[i] as PromiseFulfilledResult<any>).value : null;
      setTotal(val(0)?.data || null);
      setByEndpoint(val(1)?.data || []);
      setByOp(val(2)?.data || []);
      setTimeline(val(3)?.data || []);
      setSessions(val(4)?.data || []);
      if (results.every(r => r.status === "rejected")) setFetchError(true);
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, period]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    if (serviceRunning && fetchError) fetchAll();
  }, [serviceRunning, fetchError, fetchAll]);

  const maxTl = Math.max(...timeline.map((r) => r.total_tokens), 1);

  if (!serviceRunning) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <IconStatus size={48} />
        <div className="mt-3 font-semibold">{t("tokenStats.title")}</div>
        <div className="mt-1 text-xs opacity-50">{t("tokenStats.serviceNotRunning")}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[960px] space-y-6 px-6 py-5">
      {/* ── Header: title + toggle ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5 min-w-0">
          <h2 className="text-lg font-bold tracking-tight">
            {t("tokenStats.title", "Token 用量统计")}
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("tokenStats.disclaimer", "⚠ 本地 token 计算与服务商算法无法保证完全一致，实际用量以服务商账单为准，此处统计仅供参考。")}
          </p>
        </div>
        {onToggleDisabled && (
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <Label htmlFor="token-tracking-switch" className="text-xs text-muted-foreground cursor-pointer">
              {disabled
                ? t("common.disabled", { label: t("sidebar.tokenStats") })
                : t("common.enabled", { label: t("sidebar.tokenStats") })}
            </Label>
            <Switch
              id="token-tracking-switch"
              checked={!disabled}
              onCheckedChange={onToggleDisabled}
            />
          </div>
        )}
      </div>

      {disabled ? (
        <Card className="opacity-50">
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground text-sm">此模块已禁用，点击上方开关启用</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Period selector ── */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {PERIOD_KEYS.map((pk) => (
              <Button
                key={pk}
                size="xs"
                variant={period === pk ? "default" : "outline"}
                onClick={() => setPeriod(pk)}
              >
                {t(PERIOD_I18N[pk])}
              </Button>
            ))}
            <Button size="xs" variant="outline" onClick={fetchAll} disabled={loading}>
              {loading ? "..." : t("tokenStats.refresh", "刷新")}
            </Button>
          </div>

          {/* ── Summary cards ── */}
          {total && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                { label: t("tokenStats.totalTokens", "总 Token"), value: fmtNum(total.total_tokens), color: STAT_COLORS[0] },
                { label: t("tokenStats.inputTokens", "输入"), value: fmtNum(total.total_input), color: STAT_COLORS[1] },
                { label: t("tokenStats.outputTokens", "输出"), value: fmtNum(total.total_output), color: STAT_COLORS[2] },
                { label: t("tokenStats.requests", "请求数"), value: fmtNum(total.request_count), color: STAT_COLORS[3] },
                { label: t("tokenStats.estimatedCost", "预估费用"), value: fmtCost(total.total_cost), color: STAT_COLORS[4] },
              ].map((card) => (
                <Card key={card.label} className="py-4 gap-1">
                  <CardHeader className="py-0 px-4">
                    <CardDescription className="text-[11px]">{card.label}</CardDescription>
                  </CardHeader>
                  <CardContent className="px-4 py-0">
                    <span className="text-xl font-bold" style={{ color: card.color }}>{card.value}</span>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* ── Timeline bar chart ── */}
          {timeline.length > 0 && (
            <Card className="py-4 gap-3">
              <CardHeader className="py-0 px-4">
                <CardTitle className="text-sm">{t("tokenStats.timeline", "时间线")}</CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-0 space-y-2">
                <div className="flex items-end gap-[2px] h-24 rounded-lg bg-muted/40 px-1">
                  {timeline.map((r, i) => {
                    const h = (r.total_tokens / maxTl) * 90;
                    const inH = (r.total_input / maxTl) * 90;
                    return (
                      <div
                        key={i}
                        className="flex-1 flex flex-col justify-end items-center h-full"
                        title={`${utcToLocal(r.time_bucket)}\nInput: ${fmtNum(r.total_input)}\nOutput: ${fmtNum(r.total_output)}\nTotal: ${fmtNum(r.total_tokens)}`}
                      >
                        <div className="w-full flex flex-col justify-end">
                          <div className="rounded-t-sm min-w-[3px]" style={{ height: Math.max(h - inH, 1), background: "#10b981" }} />
                          <div className="rounded-b-sm min-w-[3px]" style={{ height: Math.max(inH, 1), background: "#3b82f6" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[9px] text-muted-foreground px-1">
                  <span>{utcToLocal(timeline[0]?.time_bucket || "")}</span>
                  <span>{utcToLocal(timeline[timeline.length - 1]?.time_bucket || "")}</span>
                </div>
                <div className="flex gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-sm bg-[#3b82f6]" />Input
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-sm bg-[#10b981]" />Output
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Distribution: by endpoint + by operation type ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="py-4 gap-3">
              <CardHeader className="py-0 px-4">
                <CardTitle className="text-sm">{t("tokenStats.byEndpoint", "按端点")}</CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-0 space-y-2.5">
                {byEndpoint.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50">{t("tokenStats.noData", "暂无数据")}</p>
                ) : byEndpoint.map((row) => {
                  const maxRow = byEndpoint[0]?.total_tokens || 1;
                  return (
                    <div key={row.group_key} className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold truncate mr-2">{row.group_key || "(unknown)"}</span>
                        <span className="text-muted-foreground shrink-0">
                          {fmtNum(row.total_tokens)}
                          {row.total_cost > 0 && (
                            <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0 text-amber-500">
                              {fmtCost(row.total_cost)}
                            </Badge>
                          )}
                        </span>
                      </div>
                      <MiniBar value={row.total_tokens} max={maxRow} />
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card className="py-4 gap-3">
              <CardHeader className="py-0 px-4">
                <CardTitle className="text-sm">{t("tokenStats.byOperation", "按操作类型")}</CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-0 space-y-2.5">
                {byOp.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50">{t("tokenStats.noData", "暂无数据")}</p>
                ) : byOp.map((row) => {
                  const maxRow = byOp[0]?.total_tokens || 1;
                  return (
                    <div key={row.group_key} className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold truncate mr-2">{row.group_key || "(unknown)"}</span>
                        <span className="text-muted-foreground shrink-0">
                          {fmtNum(row.total_tokens)} · {row.request_count} reqs
                        </span>
                      </div>
                      <MiniBar value={row.total_tokens} max={maxRow} color="#8b5cf6" />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          {/* ── Sessions table ── */}
          {sessions.length > 0 && (
            <Card className="py-4 gap-3">
              <CardHeader className="py-0 px-4">
                <CardTitle className="text-sm">{t("tokenStats.sessions", "按会话")}</CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[11px] h-8 px-2">Session</TableHead>
                      <TableHead className="text-[11px] h-8 px-2 text-right">Input</TableHead>
                      <TableHead className="text-[11px] h-8 px-2 text-right">Output</TableHead>
                      <TableHead className="text-[11px] h-8 px-2 text-right">Total</TableHead>
                      <TableHead className="text-[11px] h-8 px-2 text-right">Reqs</TableHead>
                      <TableHead className="text-[11px] h-8 px-2 text-right">Cost</TableHead>
                      <TableHead className="text-[11px] h-8 px-2">Endpoints</TableHead>
                      <TableHead className="text-[11px] h-8 px-2">Last</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((s) => (
                      <TableRow key={s.session_id}>
                        <TableCell className="px-2 py-1.5 font-mono text-[10px] max-w-[160px] truncate">{s.session_id}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[11px] text-right">{fmtNum(s.total_input)}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[11px] text-right">{fmtNum(s.total_output)}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[11px] text-right font-semibold">{fmtNum(s.total_tokens)}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[11px] text-right">{s.request_count}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[10px] text-right text-amber-500">{fmtCost(s.total_cost)}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[10px]">{s.endpoints}</TableCell>
                        <TableCell className="px-2 py-1.5 text-[10px] text-muted-foreground">{utcToLocal(s.last_call || "")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
