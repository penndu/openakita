/**
 * V2 organisation template picker drawer.
 *
 * Phase-6 entry point for the v2 "create org from template" flow.
 * Lists the templates returned by ``GET /api/v2/orgs/templates``
 * (which is gated by ``settings.runtime_v2_enabled`` on the
 * backend), lets the operator name the new org, and POSTs to
 * ``/templates/{id}/instantiate``. The returned :class:`OrgWire` is
 * passed up to the caller via ``onCreated`` — the caller decides
 * whether to immediately ``POST /api/v2/orgs`` to persist it.
 *
 * We intentionally keep this component independent of the bigger
 * org editor: it should be embeddable inside any view that wants to
 * spin up a v2 org. The default trigger is a button labelled
 * "新建 v2 组织"; callers can pass their own children for custom
 * placement.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

import {
  type OrgWire,
  type TemplateWire,
  instantiateTemplate,
  listTemplates,
} from "../api/orgs";

interface TemplatePickerDrawerProps {
  /** ``httpApiBase()`` result — the v1/v2 base URL of the backend. */
  apiBase: string;
  /** Called after a successful instantiate. The org is *not* persisted yet. */
  onCreated: (org: OrgWire) => void;
  /** Optional custom trigger; if omitted a default button is rendered. */
  children?: React.ReactNode;
}

export function TemplatePickerDrawer({
  apiBase,
  onCreated,
  children,
}: TemplatePickerDrawerProps) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateWire[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listTemplates(apiBase);
      setTemplates(resp);
      if (resp.length > 0 && selectedId === null) {
        setSelectedId(resp[0].id);
      }
    } catch (e) {
      // v2 disabled returns 404 with a friendly detail — surface it
      const msg = e instanceof Error ? e.message : String(e);
      setError(`无法加载 v2 模板：${msg}（v2 灰度未启用时是正常的）`);
    } finally {
      setLoading(false);
    }
  }, [apiBase, selectedId]);

  useEffect(() => {
    if (open) {
      loadTemplates();
    }
  }, [open, loadTemplates]);

  const handleSubmit = useCallback(async () => {
    if (!selectedId || !name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const org = await instantiateTemplate(apiBase, selectedId, { name: name.trim() });
      onCreated(org);
      setOpen(false);
      setName("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`实例化失败：${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [apiBase, selectedId, name, onCreated]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {children ?? <Button variant="outline">新建 v2 组织</Button>}
      </SheetTrigger>
      <SheetContent side="right" className="w-[420px] sm:w-[480px]">
        <SheetHeader>
          <SheetTitle>选择 v2 组织模板</SheetTitle>
          <SheetDescription>
            从内置模板克隆一份新的组织，仍未持久化——可在编辑后再保存。
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 py-4 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>加载模板中…</span>
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive border border-destructive/40 rounded-md p-2">
              {error}
            </div>
          )}

          {!loading && templates.length === 0 && !error && (
            <div className="text-sm text-muted-foreground">
              暂无可用模板。请确认后端已启用 ``settings.runtime_v2_enabled``。
            </div>
          )}

          {templates.length > 0 && (
            <ul className="space-y-2 max-h-[40vh] overflow-y-auto">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 transition ${
                      selectedId === t.id
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="font-medium text-sm">{t.name || t.id}</div>
                    {t.description && (
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {t.description}
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1">
                      节点 {t.node_count}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="tpd-org-name">
              新组织名称
            </label>
            <input
              id="tpd-org-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：Acme 编辑部"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>

        <SheetFooter>
          <SheetClose asChild>
            <Button variant="ghost" disabled={submitting}>
              取消
            </Button>
          </SheetClose>
          <Button
            onClick={handleSubmit}
            disabled={!selectedId || !name.trim() || submitting}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            创建组织
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export default TemplatePickerDrawer;
