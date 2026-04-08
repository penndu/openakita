import type { ComponentType } from "react";

import { IconX } from "../../icons";
import { safeFetch } from "../../providers";
import type { OrgFull } from "./types";
import { fmtShortDate } from "./helpers";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

type MdMods = {
  ReactMarkdown: ComponentType<{ children: string; remarkPlugins?: any[]; rehypePlugins?: any[] }>;
  remarkGfm: any;
  rehypeHighlight: any;
};

export interface OrgBlackboardPanelProps {
  currentOrg: OrgFull;
  apiBaseUrl: string;
  md: MdMods | null;
  bbEntries: any[];
  setBbEntries: React.Dispatch<React.SetStateAction<any[]>>;
  bbScope: "all" | "org" | "department" | "node";
  setBbScope: (v: "all" | "org" | "department" | "node") => void;
  bbLoading: boolean;
  fetchBlackboard: (orgId: string, scope: string) => void;
  onClose: () => void;
  embedded?: boolean;
}

export function OrgBlackboardPanel({
  currentOrg,
  apiBaseUrl,
  md,
  bbEntries,
  setBbEntries,
  bbScope,
  setBbScope,
  bbLoading,
  fetchBlackboard,
  onClose,
  embedded = false,
}: OrgBlackboardPanelProps) {
  return (
    <div className="flex h-full flex-col bg-background">
      {!embedded && (
        <div className="flex items-start justify-between border-b px-4 pt-4 pb-3">
          <div>
            <div className="mb-1 text-base font-semibold">组织黑板</div>
            <div className="text-xs text-muted-foreground">组织事实、决策、进展与待办的关键沉淀</div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <IconX size={14} />
          </Button>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <ToggleGroup
            type="single"
            value={bbScope}
            onValueChange={(v) => { if (v) setBbScope(v as typeof bbScope); }}
            variant="outline"
            size="sm"
            className="flex-wrap"
          >
            <ToggleGroupItem value="all" className="text-[10px] h-7 px-2">全部</ToggleGroupItem>
            <ToggleGroupItem value="org" className="text-[10px] h-7 px-2">组织级</ToggleGroupItem>
            <ToggleGroupItem value="department" className="text-[10px] h-7 px-2">部门级</ToggleGroupItem>
            <ToggleGroupItem value="node" className="text-[10px] h-7 px-2">节点级</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0 text-[10px]"
            onClick={() => fetchBlackboard(currentOrg.id, bbScope)}
            disabled={bbLoading}
          >
            {bbLoading ? "..." : "刷新"}
          </Button>
        </div>

        {bbEntries.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-8 text-center text-[11px] text-muted-foreground">
            {bbLoading ? "加载中..." : "暂无记录"}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {bbEntries.map((entry: any) => {
              const scopeLabel = entry.scope === "org" ? "组织" : entry.scope === "department" ? entry.scope_owner : entry.source_node || "节点";
              const typeColors: Record<string, string> = {
                fact: "#3b82f6", decision: "#f59e0b", lesson: "#10b981",
                progress: "#8b5cf6", todo: "#ef4444",
              };
              const typeLabels: Record<string, string> = {
                fact: "事实", decision: "决策", lesson: "经验",
                progress: "进展", todo: "待办",
              };
              return (
                <div key={entry.id} className="rounded-xl border bg-card p-3 text-[11px]">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1.5 py-0 font-semibold"
                        style={{
                          background: (typeColors[entry.memory_type] || "#6b7280") + "18",
                          color: typeColors[entry.memory_type] || "#6b7280",
                          borderColor: (typeColors[entry.memory_type] || "#6b7280") + "40",
                        }}
                      >
                        {typeLabels[entry.memory_type] || entry.memory_type}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{scopeLabel}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-5 w-5 text-muted-foreground"
                      title="删除此条"
                      onClick={async () => {
                        try {
                          await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/memory/${entry.id}`, { method: "DELETE" });
                          setBbEntries((prev) => prev.filter((e: any) => e.id !== entry.id));
                        } catch { /* ignore */ }
                      }}
                    >
                      ×
                    </Button>
                  </div>
                  <div className="bb-entry-content break-words leading-relaxed">
                    {md ? (
                      <md.ReactMarkdown remarkPlugins={[md.remarkGfm]} rehypePlugins={[md.rehypeHighlight]}>
                        {entry.content}
                      </md.ReactMarkdown>
                    ) : (
                      <pre className="m-0 whitespace-pre-wrap font-[inherit]">{entry.content}</pre>
                    )}
                  </div>
                  {Array.isArray(entry.tags) && entry.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.tags.map((t: string) => (
                        <Badge key={t} variant="secondary" className="text-[9px] px-1 py-0">#{t}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {entry.source_node && <span>来自 {entry.source_node} · </span>}
                    {fmtShortDate(entry.created_at)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
