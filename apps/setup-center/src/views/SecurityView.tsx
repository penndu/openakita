import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  IconShield, IconRefresh, IconPlus, IconX, IconTrash,
  IconChevronDown, IconChevronRight, IconClock, IconSave, IconAlertCircle,
} from "../icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import { Loader2, RotateCw, Save, ShieldAlert } from "lucide-react";

type SecurityViewProps = {
  apiBaseUrl: string;
  serviceRunning: boolean;
};

type ZoneConfig = {
  workspace: string[];
  controlled: string[];
  protected: string[];
  forbidden: string[];
  default_zone?: string;
};

type CommandConfig = {
  custom_critical: string[];
  custom_high: string[];
  excluded_patterns: string[];
  blocked_commands: string[];
};

type SandboxConfig = {
  enabled: boolean;
  backend: string;
  sandbox_risk_levels: string[];
  exempt_commands: string[];
};

type AuditEntry = {
  ts: number;
  tool: string;
  decision: string;
  reason: string;
  policy: string;
};

type CheckpointEntry = {
  checkpoint_id: string;
  timestamp: number;
  tool_name: string;
  description: string;
  file_count: number;
};

const ZONE_META: Record<string, { color: string; tw: string }> = {
  workspace: { color: "#22c55e", tw: "bg-emerald-500" },
  controlled: { color: "#3b82f6", tw: "bg-blue-500" },
  protected: { color: "#f59e0b", tw: "bg-amber-500" },
  forbidden: { color: "#ef4444", tw: "bg-red-500" },
};

const BACKEND_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "low_integrity", label: "Low Integrity (Windows)" },
  { value: "bubblewrap", label: "Bubblewrap (Linux)" },
  { value: "seatbelt", label: "Seatbelt (macOS)" },
  { value: "docker", label: "Docker" },
  { value: "none", label: "None (Disabled)" },
];

type TabId = "zones" | "commands" | "sandbox" | "audit" | "checkpoints";

export default function SecurityView({ apiBaseUrl, serviceRunning }: SecurityViewProps) {
  const { t } = useTranslation();

  const [tab, setTab] = useState<TabId>("zones");
  const [zones, setZones] = useState<ZoneConfig>({ workspace: [], controlled: [], protected: [], forbidden: [] });
  const [commands, setCommands] = useState<CommandConfig>({ custom_critical: [], custom_high: [], excluded_patterns: [], blocked_commands: [] });
  const [sandbox, setSandbox] = useState<SandboxConfig>({ enabled: true, backend: "auto", sandbox_risk_levels: ["HIGH"], exempt_commands: [] });
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const api = useCallback(async (path: string, method = "GET", body?: unknown) => {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${apiBaseUrl}${path}`, opts);
    return res.json();
  }, [apiBaseUrl]);

  const load = useCallback(async () => {
    if (!serviceRunning) return;
    try {
      const [zRes, cRes, sRes] = await Promise.all([
        api("/api/config/security/zones"),
        api("/api/config/security/commands"),
        api("/api/config/security/sandbox"),
      ]);
      setZones(zRes);
      setCommands(cRes);
      setSandbox(sRes);
    } catch { /* ignore */ }
  }, [api, serviceRunning]);

  useEffect(() => { load(); }, [load]);

  const loadAudit = useCallback(async () => {
    if (!serviceRunning) return;
    try {
      const res = await api("/api/config/security/audit");
      setAudit(res.entries || []);
    } catch { /* ignore */ }
  }, [api, serviceRunning]);

  const loadCheckpoints = useCallback(async () => {
    if (!serviceRunning) return;
    try {
      const res = await api("/api/config/security/checkpoints");
      setCheckpoints(res.checkpoints || []);
    } catch { /* ignore */ }
  }, [api, serviceRunning]);

  useEffect(() => {
    if (tab === "audit") loadAudit();
    if (tab === "checkpoints") loadCheckpoints();
  }, [tab, loadAudit, loadCheckpoints]);

  const doSave = async (endpoint: string, body: unknown, successKey: string) => {
    setSaving(true);
    try {
      await api(endpoint, "POST", body);
      toast.success(t(`security.${successKey}`));
    } catch {
      toast.error(t("security.saveFailed"));
    }
    setSaving(false);
  };

  const rewindCheckpoint = async (id: string) => {
    if (!confirm(t("security.rewindConfirm", { id }))) return;
    try {
      await api("/api/config/security/checkpoint/rewind", "POST", { checkpoint_id: id });
      toast.success(t("security.rewound"));
      loadCheckpoints();
    } catch { /* ignore */ }
  };

  if (!serviceRunning) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <ShieldAlert size={32} className="mb-3 opacity-50" />
        <p className="text-sm">{t("security.backendOff")}</p>
      </div>
    );
  }

  const TABS: { id: TabId; labelKey: string }[] = [
    { id: "zones", labelKey: "security.zones" },
    { id: "commands", labelKey: "security.commands" },
    { id: "sandbox", labelKey: "security.sandbox" },
    { id: "audit", labelKey: "security.audit" },
    { id: "checkpoints", labelKey: "security.checkpoints" },
  ];

  return (
    <div>
      {/* Header + Tab bar */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={(v) => { if (v) setTab(v as TabId); }}
          variant="outline"
        >
          {TABS.map((tb) => (
            <ToggleGroupItem
              key={tb.id}
              value={tb.id}
              className="text-sm data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
            >
              {t(tb.labelKey)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* Zones */}
      {tab === "zones" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("security.zonesDesc")}</p>
          {(["workspace", "controlled", "protected", "forbidden"] as const).map((zone) => (
            <ZonePanel
              key={zone}
              zone={zone}
              paths={zones[zone] || []}
              onChange={(paths) => setZones((prev) => ({ ...prev, [zone]: paths }))}
            />
          ))}
          <Button onClick={() => doSave("/api/config/security/zones", zones, "zonesSaved")} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save size={14} />}
            {t("security.save")}
          </Button>
        </div>
      )}

      {/* Commands */}
      {tab === "commands" && (
        <Card className="py-0">
          <CardContent className="space-y-5 py-5">
            <p className="text-sm text-muted-foreground">{t("security.commandsDesc")}</p>
            <TagEditor
              label={t("security.criticalPatterns")}
              items={commands.custom_critical}
              onChange={(v) => setCommands((p) => ({ ...p, custom_critical: v }))}
              placeholder={`e.g. rm\\s+-rf\\s+/`}
            />
            <TagEditor
              label={t("security.highPatterns")}
              items={commands.custom_high}
              onChange={(v) => setCommands((p) => ({ ...p, custom_high: v }))}
              placeholder="e.g. Remove-Item.*-Recurse"
            />
            <TagEditor
              label={t("security.excludedPatterns")}
              items={commands.excluded_patterns}
              onChange={(v) => setCommands((p) => ({ ...p, excluded_patterns: v }))}
              placeholder={t("security.excludedPh")}
            />
            <TagEditor
              label={t("security.blockedCommands")}
              items={commands.blocked_commands}
              onChange={(v) => setCommands((p) => ({ ...p, blocked_commands: v }))}
              placeholder="e.g. diskpart"
            />
            <Button onClick={() => doSave("/api/config/security/commands", commands, "commandsSaved")} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save size={14} />}
              {t("security.save")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Sandbox */}
      {tab === "sandbox" && (
        <Card className="py-0">
          <CardContent className="space-y-5 py-5">
            <p className="text-sm text-muted-foreground">{t("security.sandboxDesc")}</p>
            <div className="flex items-center gap-3">
              <Switch
                checked={sandbox.enabled}
                onCheckedChange={(v) => setSandbox((p) => ({ ...p, enabled: v }))}
              />
              <Label className="text-sm">{t("security.sandboxEnabled")}</Label>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">{t("security.sandboxBackend")}</Label>
              <Select
                value={sandbox.backend}
                onValueChange={(v) => setSandbox((p) => ({ ...p, backend: v }))}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BACKEND_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => doSave("/api/config/security/sandbox", sandbox, "sandboxSaved")} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save size={14} />}
              {t("security.save")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Audit */}
      {tab === "audit" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("security.auditCount", { count: audit.length })}
            </span>
            <Button variant="outline" size="sm" onClick={loadAudit}>
              <RotateCw size={14} /> {t("security.refresh")}
            </Button>
          </div>
          {audit.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-sm">
              <IconShield size={28} className="mx-auto mb-2 opacity-30" />
              {t("security.noAudit")}
            </div>
          ) : (
            <Card className="py-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">{t("security.auditDecision")}</TableHead>
                    <TableHead>{t("security.auditTool")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("security.auditReason")}</TableHead>
                    <TableHead className="w-[100px] text-right">{t("security.auditTime")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...audit].reverse().map((e, i) => (
                    <TableRow key={i}>
                      <TableCell><DecisionBadge decision={e.decision} /></TableCell>
                      <TableCell className="font-medium">{e.tool}</TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground text-xs max-w-[300px] truncate">{e.reason}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(e.ts * 1000).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      )}

      {/* Checkpoints */}
      {tab === "checkpoints" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("security.checkpointCount", { count: checkpoints.length })}
            </span>
            <Button variant="outline" size="sm" onClick={loadCheckpoints}>
              <RotateCw size={14} /> {t("security.refresh")}
            </Button>
          </div>
          {checkpoints.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-sm">
              <IconClock size={28} className="mx-auto mb-2 opacity-30" />
              {t("security.noCheckpoints")}
            </div>
          ) : (
            <Card className="py-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>{t("security.checkpointTool")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("security.checkpointFiles")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("security.checkpointTime")}</TableHead>
                    <TableHead className="w-[80px] text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checkpoints.map((cp) => (
                    <TableRow key={cp.checkpoint_id}>
                      <TableCell className="font-mono text-xs truncate max-w-[180px]">{cp.checkpoint_id}</TableCell>
                      <TableCell className="text-sm">{cp.tool_name}</TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground">
                        {cp.file_count} {t("security.files")}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(cp.timestamp * 1000).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => rewindCheckpoint(cp.checkpoint_id)}>
                          {t("security.rewind")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─── */

function DecisionBadge({ decision }: { decision: string }) {
  const variant = decision === "deny" ? "destructive" : decision === "confirm" ? "outline" : "secondary";
  return (
    <Badge variant={variant} className="text-[11px] uppercase shrink-0">
      {decision}
    </Badge>
  );
}

function ZonePanel({ zone, paths, onChange }: {
  zone: string;
  paths: string[]; onChange: (v: string[]) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(zone === "workspace" || zone === "controlled");
  const meta = ZONE_META[zone];

  const add = () => {
    const v = input.trim();
    if (v && !paths.includes(v)) onChange([...paths, v]);
    setInput("");
  };

  return (
    <Card className="py-0 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
      >
        <span className={cn("size-2.5 rounded-full shrink-0", meta.tw)} />
        <span className="flex-1 text-sm font-semibold">{t(`security.zone_${zone}`)}</span>
        <Badge variant="secondary" className="text-[11px]">{paths.length}</Badge>
        {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
      </button>
      {expanded && (
        <CardContent className="pt-0 pb-4 space-y-1.5">
          {paths.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5 group">
              <code className="flex-1 text-xs px-2 py-1 bg-muted rounded">{p}</code>
              <Button
                variant="ghost" size="icon"
                className="size-6 opacity-0 group-hover:opacity-100 text-destructive"
                onClick={() => onChange(paths.filter((_, j) => j !== i))}
              >
                <IconX size={12} />
              </Button>
            </div>
          ))}
          <div className="flex gap-1.5 mt-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="D:/path/to/dir/**"
              className="h-8 text-xs"
            />
            <Button variant="outline" size="sm" onClick={add}>
              <IconPlus size={12} />
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function TagEditor({ label, items, onChange, placeholder }: {
  label: string; items: string[]; onChange: (v: string[]) => void; placeholder?: string;
}) {
  const [input, setInput] = useState("");

  const add = () => {
    const v = input.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setInput("");
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <Badge key={i} variant="secondary" className="gap-1 pr-1 font-mono text-xs">
              {item}
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="ml-0.5 rounded-sm hover:bg-destructive/20 transition-colors"
              >
                <IconX size={10} className="text-muted-foreground hover:text-destructive" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          className="h-8 text-xs"
        />
        <Button variant="outline" size="sm" onClick={add}>
          <IconPlus size={12} />
        </Button>
      </div>
    </div>
  );
}
