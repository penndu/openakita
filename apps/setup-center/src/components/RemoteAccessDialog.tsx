import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, AlertTriangle, Copy, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { safeFetch } from "../providers";
import { copyToClipboard } from "../utils/clipboard";
import type { EnvMap } from "../types";

export interface RemoteAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiBaseUrl: string;
  serviceRunning: boolean;
  envDraft: EnvMap;
  setEnvDraft: React.Dispatch<React.SetStateAction<EnvMap>>;
  restartService: () => Promise<void>;
  askConfirm: (msg: string, onConfirm: () => void) => void;
}

export function RemoteAccessDialog({
  open, onOpenChange, apiBaseUrl, serviceRunning,
  envDraft, setEnvDraft, restartService,
  askConfirm,
}: RemoteAccessDialogProps) {
  const { t } = useTranslation();

  const [localIp, setLocalIp] = useState("");
  const [allIps, setAllIps] = useState<string[]>([]);
  const [selectedIp, setSelectedIp] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);

  const externalEnabled = envDraft.API_HOST === "0.0.0.0";
  const webPwdSet = !!(envDraft.OPENAKITA_WEB_PASSWORD || "").trim();
  const port = new URL(apiBaseUrl || "http://127.0.0.1:18900").port || "18900";
  const activeIp = selectedIp || localIp;
  const accessUrl = activeIp ? `http://${activeIp}:${port}/web` : "";

  const fetchNetworkInfo = useCallback(async () => {
    const base = apiBaseUrl || "http://127.0.0.1:18900";
    try {
      const res = await safeFetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        const ip = data.local_ip || "";
        const ips: string[] = data.all_ips || [];
        setLocalIp(ip);
        setAllIps(ips.length > 0 ? ips : ip ? [ip] : []);
        setSelectedIp((prev) => prev || ip);
      }
    } catch { /* ignore */ }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (open && serviceRunning) {
      fetchNetworkInfo();
    }
  }, [open, serviceRunning, fetchNetworkInfo]);

  const handleEnableExternal = () => {
    askConfirm(
      t("adv.apiHostWarn"),
      async () => {
        setEnabling(true);
        try {
          await safeFetch(`${apiBaseUrl}/api/config/env`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entries: { API_HOST: "0.0.0.0" }, delete_keys: [] }),
          });
          setEnvDraft((prev) => ({ ...prev, API_HOST: "0.0.0.0" }));
          await restartService();
        } catch {
          toast.error(t("config.restartFail"));
        } finally {
          setEnabling(false);
        }
      },
    );
  };

  const handleCopyUrl = async () => {
    if (!accessUrl) return;
    const ok = await copyToClipboard(accessUrl);
    if (ok) toast.success(t("remoteAccess.urlCopied"));
  };

  const handleGoSetPassword = () => {
    onOpenChange(false);
    window.location.hash = "#/config/advanced";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("remoteAccess.title")}</DialogTitle>
          <DialogDescription>{t("remoteAccess.desc")}</DialogDescription>
        </DialogHeader>

        {/* -- Section: Environment checks -- */}
        <div className="space-y-2.5">
          {/* Service status */}
          <StatusRow
            ok={serviceRunning}
            label={serviceRunning ? t("remoteAccess.serviceOk") : t("remoteAccess.serviceOff")}
            detail={`${t("remoteAccess.port")}: ${port}`}
          />

          {/* External access */}
          <StatusRow
            ok={externalEnabled}
            warn={!externalEnabled}
            label={externalEnabled ? t("remoteAccess.externalOn") : t("remoteAccess.externalOff")}
            action={!externalEnabled && serviceRunning ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={enabling}
                onClick={handleEnableExternal}
              >
                {enabling ? t("remoteAccess.enabling") : t("remoteAccess.enableExternal")}
              </Button>
            ) : undefined}
          />

          {/* LAN IP */}
          <StatusRow
            ok={!!activeIp}
            label={activeIp
              ? `${t("remoteAccess.lanIp")}: ${activeIp}`
              : t("remoteAccess.lanIpNone")}
            action={allIps.length > 1 ? (
              <Select value={selectedIp} onValueChange={setSelectedIp}>
                <SelectTrigger className="h-7 w-[150px] text-xs">
                  <SelectValue placeholder={t("remoteAccess.selectIp")} />
                </SelectTrigger>
                <SelectContent>
                  {allIps.map((ip) => (
                    <SelectItem key={ip} value={ip} className="text-xs">{ip}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : undefined}
          />

          {/* Web password */}
          <StatusRow
            ok={webPwdSet}
            warn={!webPwdSet}
            label={webPwdSet ? t("remoteAccess.webPwdSet") : t("remoteAccess.webPwdNotSet")}
            action={!webPwdSet && serviceRunning ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleGoSetPassword}
              >
                {t("remoteAccess.goSetPwd")}
              </Button>
            ) : undefined}
          />
        </div>

        {/* -- Section: URL + QR code -- */}
        {activeIp && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={accessUrl}
                className="text-xs font-mono h-8 flex-1"
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 shrink-0"
                onClick={handleCopyUrl}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* QR code area */}
            <div className="flex flex-col items-center">
              <div className="relative">
                <div className="bg-white p-3 rounded-lg inline-block">
                  <QRCodeSVG value={accessUrl} size={160} />
                </div>
                {!externalEnabled && (
                  <div className="absolute inset-0 bg-background/80 rounded-lg flex items-center justify-center">
                    <Badge variant="secondary" className="text-xs">
                      {t("remoteAccess.qrDisabledHint")}
                    </Badge>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {t("remoteAccess.scanQr")}
              </p>
            </div>
          </div>
        )}

        {/* -- Section: Steps (collapsible) -- */}
        <CollapsibleSection
          open={stepsOpen}
          onToggle={() => setStepsOpen((v) => !v)}
          title={t("remoteAccess.stepsTitle")}
        >
          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
            <li>{t("remoteAccess.step1")}</li>
            <li>{t("remoteAccess.step2")}</li>
            <li>{t("remoteAccess.step3")}</li>
            <li>{t("remoteAccess.step4")}</li>
          </ol>
        </CollapsibleSection>

        {/* -- Section: FAQ (collapsible) -- */}
        <CollapsibleSection
          open={faqOpen}
          onToggle={() => setFaqOpen((v) => !v)}
          title={t("remoteAccess.faqTitle")}
        >
          <ul className="text-xs text-muted-foreground space-y-1.5">
            <li>{t("remoteAccess.faq1")}</li>
            <li>{t("remoteAccess.faq2")}</li>
            <li>{t("remoteAccess.faq3")}</li>
          </ul>
        </CollapsibleSection>
      </DialogContent>
    </Dialog>
  );
}

function StatusRow({ ok, warn, label, detail, action }: {
  ok: boolean;
  warn?: boolean;
  label: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : XCircle;
  const color = ok ? "text-emerald-500" : warn ? "text-amber-500" : "text-destructive";

  return (
    <div className="flex items-center justify-between gap-2 min-h-[28px]">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={`h-4 w-4 shrink-0 ${color}`} />
        <span className="text-sm truncate">{label}</span>
        {detail && (
          <span className="text-xs text-muted-foreground shrink-0">{detail}</span>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function CollapsibleSection({ open, onToggle, title, children }: {
  open: boolean;
  onToggle: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="border-t pt-2">
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left"
        onClick={onToggle}
      >
        <Icon className="h-3.5 w-3.5" />
        {title}
      </button>
      {open && <div className="mt-2 pl-5">{children}</div>}
    </div>
  );
}
