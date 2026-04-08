import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useLayoutEffect,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  Background,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
  MarkerType,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  IconPlus,
  IconTrash,
  IconCheck,
  IconX,
  IconUsers,
  IconChevronDown,
  IconSitemap,
  IconMaximize2,
  IconAlertCircle,
} from "../icons";
import { safeFetch } from "../providers";
import { IS_CAPACITOR, saveFileDialog, IS_TAURI, writeTextFile } from "../platform";
import { OrgInboxSidebar } from "../components/OrgInboxSidebar";
import { PanelShell } from "../components/PanelShell";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { OrgAvatar, AVATAR_PRESETS, AVATAR_MAP } from "../components/OrgAvatars";
import { OrgChatPanel } from "../components/OrgChatPanel";
import { OrgDashboard } from "../components/OrgDashboard";
import { OrgProjectBoard } from "../components/OrgProjectBoard";
import {
  type OrgNodeData,
  type OrgEdgeData,
  type OrgSummary,
  type OrgFull,
  type TemplateSummary,
  type RightPanelMode,
  type ActivityEvent,
  EDGE_COLORS,
  STATUS_COLORS,
  STATUS_LABELS,
  fmtTime,
  fmtDateTime,
  fmtShortDate,
  orgNodeToFlowNode,
  orgEdgeToFlowEdge,
  computeTreeLayout,
  getNextNodePosition,
  detectOverlap,
  nodeTypes,
  OrgCanvasControls,
  NodeTasksTabContent,
  OrgEdgeInspector,
  OrgNodeInspector,
  OrgSettingsPanel,
  OrgBlackboardPanel,
  OrgEditorTopBar,
  OrgListPanel,
} from "../components/org-editor";



// ── Lazy markdown rendering (mirrors OrgChatPanel) ──

type MdMods = {
  ReactMarkdown: ComponentType<{ children: string; remarkPlugins?: any[]; rehypePlugins?: any[] }>;
  remarkGfm: any;
  rehypeHighlight: any;
};
let _md: MdMods | null = null;
let _mdTried = false;
function useMd(): MdMods | null {
  const [m, setM] = useState<MdMods | null>(() => _md);
  useEffect(() => {
    if (_md) { setM(_md); return; }
    if (_mdTried) return;
    _mdTried = true;
    try { new RegExp("\\p{ID_Start}", "u"); new RegExp("(?<=a)b"); } catch { return; }
    Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
      import("rehype-highlight"),
    ]).then(([md, gfm, hl]) => {
      _md = { ReactMarkdown: md.default, remarkGfm: gfm.default, rehypeHighlight: hl.default };
      setM(_md);
    }).catch(() => {});
  }, []);
  return m;
}

const EDGE_TYPE_LABELS: Record<string, string> = {
  hierarchy: "上下级",
  collaborate: "协作",
  escalate: "上报",
  consult: "咨询",
};

// ── Main Component ──

export function OrgEditorView({
  apiBaseUrl = "http://127.0.0.1:18900",
  visible = true,
}: {
  apiBaseUrl?: string;
  visible?: boolean;
}) {
  useTranslation();
  const md = useMd();

  // State
  const [orgList, setOrgList] = useState<OrgSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [currentOrg, setCurrentOrg] = useState<OrgFull | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const lastSavedRef = useRef<string>("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doSaveRef = useRef<(quiet?: boolean) => Promise<boolean>>(async () => false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showNewNodeForm, setShowNewNodeForm] = useState(false);
  const [propsTab, setPropsTab] = useState<"overview" | "identity" | "capabilities" | "tasks">("overview");
  const liveMode = currentOrg?.status === "active" || currentOrg?.status === "running";
  const [layoutLocked, setLayoutLocked] = useState(false);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({});
  const [rightPanel, setRightPanel] = useState<RightPanelMode>("none");
  const [orgBlackboardOpen, setOrgBlackboardOpen] = useState(false);
  const [inboxSummary, setInboxSummary] = useState({ unreadCount: 0, pendingApprovals: 0 });
  const [nodeEvents, setNodeEvents] = useState<any[]>([]);
  const [nodeSchedules, setNodeSchedules] = useState<any[]>([]);
  const [nodeMessages, setNodeMessages] = useState<any[]>([]);
  const [nodeThinking, setNodeThinking] = useState<any[]>([]);
  const [orgStats, setOrgStats] = useState<any>(null);
  const [toast, setToast] = useState<{ message: string; type: "ok" | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  type AgentProfileEntry = { id: string; name: string; description: string; icon: string };
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileEntry[]>([]);

  // Activity feed state
  const [activityFeed, setActivityFeed] = useState<ActivityEvent[]>([]);
  const [viewMode, setViewMode] = useState<"canvas" | "projects" | "dashboard">("canvas");
  const [taskChainFocus, setTaskChainFocus] = useState<{
    ownerNodeId: string | null;
    waitingNodeIds: string[];
    delegatedNodeIds: string[];
    waitingReplyNodeIds: string[];
    messageRoutes: Array<{ fromNodeId: string; toNodeId: string; status: string; messageCount: number }>;
  } | null>(null);
  const [chatPanelNode, setChatPanelNode] = useState<string | null>(null);
  const reactFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: "node" | "edge" | "pane";
    id: string | null;
    flowX?: number;
    flowY?: number;
  } | null>(null);
  const [clipboardNode, setClipboardNode] = useState<any>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => { window.removeEventListener("click", dismiss); window.removeEventListener("scroll", dismiss, true); };
  }, [contextMenu]);
  const [edgeAnimations, setEdgeAnimations] = useState<Record<string, { color: string; ts: number }>>({});
  const [edgeFlowCounts, setEdgeFlowCounts] = useState<Record<string, number>>({});

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[]);

  const showToast = useCallback((message: string, type: "ok" | "error" = "ok") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // MCP/Skill lists for selection
  const [availableMcpServers, setAvailableMcpServers] = useState<{ name: string; status: string }[]>([]);
  const [availableSkills, setAvailableSkills] = useState<{ name: string; description?: string; name_i18n?: string; description_i18n?: string }[]>([]);

  // Blackboard state
  const [bbEntries, setBbEntries] = useState<any[]>([]);
  const [bbScope, setBbScope] = useState<"all" | "org" | "department" | "node">("all");

  // Org settings panel collapse
  const [bbLoading, setBbLoading] = useState(false);

  // New node form
  const [newNodeTitle, setNewNodeTitle] = useState("");
  const [newNodeDept, setNewNodeDept] = useState("");
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768 || IS_CAPACITOR);
  const [showLeftPanel, setShowLeftPanel] = useState(() => !(window.innerWidth < 768 || IS_CAPACITOR));
  // rightPanel state (declared above) replaces showRightPanel / inboxOpen / chatPanelOpen
  const wasRunningRef = useRef(false);

  useLayoutEffect(() => {
    let prev = window.innerWidth < 768 || IS_CAPACITOR;
    const onResize = () => {
      const mobile = window.innerWidth < 768 || IS_CAPACITOR;
      setIsMobile(mobile);
      if (mobile && !prev) setShowLeftPanel(false);
      if (!mobile && prev) setShowLeftPanel(true);
      prev = mobile;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!currentOrg) {
      wasRunningRef.current = false;
      return;
    }
    const running = currentOrg.status === "active" || currentOrg.status === "running";
    if (running !== wasRunningRef.current) {
      setLayoutLocked(running);
      wasRunningRef.current = running;
    }
  }, [currentOrg?.id, currentOrg?.status]);

  useEffect(() => {
    if (rightPanel !== "org") setOrgBlackboardOpen(false);
  }, [rightPanel]);

  // ── Data fetching ──

  const fetchOrgList = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs`);
      const data = await res.json();
      setOrgList(data);
    } catch (e) {
      console.error("Failed to fetch orgs:", e);
    }
  }, [apiBaseUrl]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/templates`);
      const data = await res.json();
      setTemplates(data);
    } catch (e) {
      console.error("Failed to fetch templates:", e);
    }
  }, [apiBaseUrl]);

  const fetchOrg = useCallback(async (orgId: string) => {
    setLoading(true);
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}`);
      const data: OrgFull = await res.json();
      setCurrentOrg(data);
      lastSavedRef.current = "";
      const flowNodes = data.nodes.map(orgNodeToFlowNode);
      const flowEdges = data.edges.map(orgEdgeToFlowEdge);
      const hasOverlap = detectOverlap(flowNodes);
      setNodes(hasOverlap ? computeTreeLayout(flowNodes, flowEdges) : flowNodes);
      setEdges(flowEdges);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setRightPanel("none");
      setOrgBlackboardOpen(false);
      const running = data.status === "active" || data.status === "running";
      setLayoutLocked(running);
    } catch (e) {
      console.error("Failed to fetch org:", e);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, setNodes, setEdges]);

  const fetchMcpServers = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/mcp/servers`);
      const data = await res.json();
      setAvailableMcpServers(data.servers || []);
    } catch { /* MCP endpoint may not be available */ }
  }, [apiBaseUrl]);

  const fetchAvailableSkills = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/skills`);
      const data = await res.json();
      setAvailableSkills(data.skills || []);
    } catch { /* skills endpoint may not be available */ }
  }, [apiBaseUrl]);

  const fetchBlackboard = useCallback(async (orgId: string, scope?: string) => {
    setBbLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (scope && scope !== "all") params.set("scope", scope);
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/memory?${params}`);
      const data = await res.json();
      setBbEntries(data || []);
    } catch {
      setBbEntries([]);
    } finally {
      setBbLoading(false);
    }
  }, [apiBaseUrl]);

  const fetchInboxSummary = useCallback(async (orgId: string) => {
    try {
      const resp = await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/inbox?limit=1`);
      if (!resp.ok) return;
      const data = await resp.json();
      setInboxSummary({
        unreadCount: data.unread_count || 0,
        pendingApprovals: data.pending_approvals || 0,
      });
    } catch {
      /* ignore */
    }
  }, [apiBaseUrl]);

  const fetchAgentProfiles = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/agents/profiles`);
      const data = await res.json();
      setAgentProfiles(data.profiles || []);
    } catch { /* ignore */ }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (visible) {
      fetchOrgList().then(() => {
        if (!selectedOrgId) {
          const params = new URLSearchParams(window.location.search);
          const urlOrg = params.get("org");
          if (urlOrg) setSelectedOrgId(urlOrg);
        }
      });
      fetchTemplates();
      fetchMcpServers();
      fetchAvailableSkills();
      fetchAgentProfiles();
    }
  }, [visible, fetchOrgList, fetchTemplates, fetchMcpServers, fetchAvailableSkills, fetchAgentProfiles]);

  useEffect(() => {
    if (selectedOrgId) {
      fetchOrg(selectedOrgId);
    }
  }, [selectedOrgId, fetchOrg]);

  useEffect(() => {
    if (currentOrg && !selectedNodeId) {
      fetchBlackboard(currentOrg.id, bbScope);
    }
  }, [currentOrg?.id, selectedNodeId, bbScope, fetchBlackboard]);

  useEffect(() => {
    if (!currentOrg?.id) {
      setInboxSummary({ unreadCount: 0, pendingApprovals: 0 });
      return;
    }
    void fetchInboxSummary(currentOrg.id);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchInboxSummary(currentOrg.id);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [currentOrg?.id, fetchInboxSummary]);

  // ── Load historical events on org switch ──
  const loadHistoricalEvents = useCallback(async (orgId: string) => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/events?limit=200`);
      const events: any[] = await res.json();
      if (!Array.isArray(events) || events.length === 0) return;
      const evtTypeMap: Record<string, string> = {
        node_activated: "org:node_status",
        node_status_change: "org:node_status",
        task_completed: "org:task_complete",
        task_assigned: "org:task_delegated",
        task_timeout: "org:task_timeout",
        task_failed: "org:node_status",
        broadcast: "org:broadcast",
        blackboard_write: "org:blackboard_update",
        meeting_completed: "org:meeting_completed",
        meeting_started: "org:meeting_started",
        conflict_detected: "org:deadlock",
        heartbeat_decision: "org:heartbeat_done",
        tools_granted: "org:node_status",
        watchdog_recovery: "org:watchdog_recovery",
      };
      const mapped: ActivityEvent[] = events
        .filter(e => e.event_type && evtTypeMap[e.event_type])
        .map(e => {
          const evName = evtTypeMap[e.event_type] || `org:${e.event_type}`;
          const data = { ...(e.data || {}), org_id: orgId, node_id: e.actor };
          if (e.event_type === "node_activated") data.status = "busy";
          if (e.event_type === "task_completed") data.status = "idle";
          if (e.event_type === "task_failed") data.status = "error";
          return {
            id: `hist_${e.timestamp || ""}${Math.random().toString(36).slice(2, 6)}`,
            time: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
            event: evName,
            data,
          };
        })
        .sort((a, b) => b.time - a.time)
        .slice(0, 200);
      if (mapped.length > 0) {
        setActivityFeed(mapped);
      }
    } catch { /* ignore */ }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (currentOrg && liveMode) {
      loadHistoricalEvents(currentOrg.id);
    }
  }, [currentOrg?.id, liveMode, loadHistoricalEvents]);

  // ── WebSocket for live mode ──

  const pushActivity = useCallback((event: string, data: any) => {
    const entry: ActivityEvent = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, time: Date.now(), event, data };
    setActivityFeed((prev) => [entry, ...prev].slice(0, 500));
  }, []);

  const triggerEdgeAnimation = useCallback((fromNode: string, toNode: string, color: string) => {
    const edgeKey = edges.find(
      (e) => (e.source === fromNode && e.target === toNode) || (e.source === toNode && e.target === fromNode),
    )?.id;
    if (!edgeKey) return;
    setEdgeAnimations((prev) => ({ ...prev, [edgeKey]: { color, ts: Date.now() } }));
    setEdgeFlowCounts((prev) => ({ ...prev, [edgeKey]: (prev[edgeKey] || 0) + 1 }));
    setTimeout(() => {
      setEdgeAnimations((prev) => {
        const copy = { ...prev };
        if (copy[edgeKey]?.ts && Date.now() - copy[edgeKey].ts >= 4500) delete copy[edgeKey];
        return copy;
      });
    }, 5000);
  }, [edges]);

  useEffect(() => {
    if (!liveMode || !currentOrg) return;
    const wsUrl = apiBaseUrl.replace(/^http/, "ws") + "/ws";
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data);
          const ev = parsed.event as string;
          const d = parsed.data;
          if (!d || d.org_id !== currentOrg.id) return;

          if (currentOrg.status !== "active" && currentOrg.status !== "running") {
            setCurrentOrg((prev) => prev ? { ...prev, status: "active" } : prev);
          }

          if (ev === "org:node_status") {
            const { node_id, status, current_task } = d;
            setNodeStatuses((prev) => ({ ...prev, [node_id]: status }));
            setNodes((prev) =>
              prev.map((n) =>
                n.id === node_id
                  ? { ...n, data: { ...n.data, status, current_task: current_task || n.data.current_task } }
                  : n,
              ),
            );
            if (status === "busy" || status === "error") pushActivity(ev, d);
          } else if (ev === "org:task_timeout") {
            pushActivity(ev, d);
          } else if (ev === "org:task_delegated") {
            pushActivity(ev, d);
            triggerEdgeAnimation(d.from_node, d.to_node, "var(--primary)");
          } else if (ev === "org:task_delivered") {
            pushActivity(ev, d);
            triggerEdgeAnimation(d.from_node, d.to_node, "var(--ok)");
          } else if (ev === "org:task_accepted") {
            pushActivity(ev, d);
            triggerEdgeAnimation(d.accepted_by, d.from_node, "#22c55e");
          } else if (ev === "org:task_rejected") {
            pushActivity(ev, d);
            triggerEdgeAnimation(d.rejected_by, d.from_node, "var(--danger)");
          } else if (ev === "org:escalation") {
            pushActivity(ev, d);
            triggerEdgeAnimation(d.from_node, d.to_node, "var(--danger)");
          } else if (ev === "org:message") {
            pushActivity(ev, d);
            triggerEdgeAnimation(d.from_node, d.to_node, "#a78bfa");
          } else if (ev === "org:broadcast") {
            pushActivity(ev, d);
          } else if (ev === "org:blackboard_update") {
            pushActivity(ev, d);
            if (currentOrg && !selectedNodeId) fetchBlackboard(currentOrg.id, bbScope);
          } else if (ev === "org:heartbeat_start" || ev === "org:heartbeat_done") {
            pushActivity(ev, d);
          } else if (ev === "org:task_complete") {
            pushActivity(ev, d);
          } else if (ev === "org:meeting_started" || ev === "org:meeting_round" || ev === "org:meeting_speak" || ev === "org:meeting_completed") {
            pushActivity(ev, d);
          } else if (ev === "org:watchdog_recovery") {
            pushActivity(ev, d);
          }
        } catch { /* ignore parse errors */ }
      };
    } catch { /* WebSocket not available */ }
    return () => { ws?.close(); };
  }, [liveMode, currentOrg, apiBaseUrl, setNodes, pushActivity, triggerEdgeAnimation, selectedNodeId, bbScope, fetchBlackboard]);

  // ── Start/Stop org ──
  const handleStartOrg = useCallback(async () => {
    if (!currentOrg) return;
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/start`, { method: "POST" });
      setCurrentOrg({ ...currentOrg, status: "active" });
      setLayoutLocked(true);
      const mode = (currentOrg as any).operation_mode || "command";
      showToast(
        mode === "autonomous"
          ? "组织已启动（自主模式）——顶层负责人将根据核心业务自动运营"
          : "组织已启动（命令模式）——可通过聊天或命令面板下达任务",
        "ok",
      );
    } catch (e) { console.error("Failed to start org:", e); }
  }, [currentOrg, apiBaseUrl, showToast]);

  const handleStopOrg = useCallback(async () => {
    if (!currentOrg) return;
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/stop`, { method: "POST" });
      setCurrentOrg({ ...currentOrg, status: "dormant" });
      setLayoutLocked(false);
    } catch (e) { console.error("Failed to stop org:", e); }
  }, [currentOrg, apiBaseUrl]);

  // ── Org export/import ──
  const orgImportRef = useRef<HTMLInputElement>(null);

  const handleExportOrg = useCallback(async () => {
    if (!currentOrg) return;
    try {
      const safeName = currentOrg.name.replace(/\s+/g, "_").replace(/[/\\]/g, "_").slice(0, 30);
      const defaultName = `${safeName}.json`;

      if (IS_TAURI) {
        const savePath = await saveFileDialog({
          title: "导出组织配置",
          defaultPath: defaultName,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!savePath) return;
        const res = await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/export`, { method: "POST" });
        const data = await res.json();
        await writeTextFile(savePath, JSON.stringify(data, null, 2));
        showToast(`组织已导出到: ${savePath}`);
      } else {
        const res = await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/export`, { method: "POST" });
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`组织「${currentOrg.name}」已导出为 ${defaultName}`);
      }
    } catch (e) { showToast(String(e), "error"); }
  }, [currentOrg, apiBaseUrl, showToast]);

  const handleImportOrg = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/import`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      showToast(data.message || `组织「${data.organization?.name || ""}」导入成功`);
      fetchOrgList();
      if (data.organization?.id) {
        setSelectedOrgId(data.organization.id);
      }
    } catch (err) { showToast(String(err), "error"); }
    if (orgImportRef.current) orgImportRef.current.value = "";
  }, [apiBaseUrl, showToast, fetchOrgList]);

  const [confirmReset, setConfirmReset] = useState(false);
  const handleResetOrg = useCallback(async () => {
    if (!currentOrg) return;
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/reset`, { method: "POST" });
      const data = await res.json();
      setCurrentOrg(data);
      setLayoutLocked(false);
      setActivityFeed([]);
      setBbEntries([]);
      setNodeEvents([]);
      setNodeThinking([]);
      setNodeSchedules([]);
      setOrgStats(null);
      showToast("组织已重置");
    } catch (e) { console.error("Failed to reset org:", e); }
    setConfirmReset(false);
  }, [currentOrg, apiBaseUrl]);

  // ── Save ──

  const buildSavePayload = useCallback(() => {
    if (!currentOrg) return null;
    const updatedNodes = nodes.map((n) => ({
      ...n.data,
      position: n.position,
    }));
    const updatedEdges = edges.map((e) => ({
      ...(e.data || {}),
      id: e.id,
      source: e.source,
      target: e.target,
      edge_type: (e.data as any)?.edge_type || "hierarchy",
      label: (e.data as any)?.label || (e.label as string) || "",
      bidirectional: (e.data as any)?.bidirectional ?? true,
      priority: (e.data as any)?.priority ?? 0,
      bandwidth_limit: (e.data as any)?.bandwidth_limit ?? 60,
    }));
    return {
      name: currentOrg.name,
      description: currentOrg.description,
      user_persona: currentOrg.user_persona || { title: "负责人", display_name: "", description: "" },
      operation_mode: (currentOrg as any).operation_mode || "command",
      core_business: currentOrg.core_business || "",
      heartbeat_enabled: currentOrg.heartbeat_enabled,
      heartbeat_interval_s: currentOrg.heartbeat_interval_s,
      standup_enabled: currentOrg.standup_enabled,
      nodes: updatedNodes,
      edges: updatedEdges,
    };
  }, [currentOrg, nodes, edges]);

  const doSave = useCallback(async (quiet = false): Promise<boolean> => {
    if (!currentOrg) return false;
    const payload = buildSavePayload();
    if (!payload) return false;
    const snapshot = JSON.stringify(payload);
    if (snapshot === lastSavedRef.current) return true;
    setSaving(true);
    setSaveStatus("saving");
    try {
      const resp = await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: snapshot,
      });
      if (!resp.ok) throw new Error(`保存失败 (${resp.status})`);
      lastSavedRef.current = snapshot;
      if (!quiet) showToast("保存成功", "ok");
      fetchOrgList();
      setSaveStatus("saved");
      return true;
    } catch (e: any) {
      console.error("Failed to save org:", e);
      if (!quiet) showToast(e.message || "保存失败", "error");
      setSaveStatus("error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [currentOrg, buildSavePayload, apiBaseUrl, fetchOrgList, showToast]);

  const handleSave = useCallback(() => doSave(false), [doSave]);

  doSaveRef.current = doSave;

  const autoSave = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => doSaveRef.current(true), 300);
  }, []);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const t = setTimeout(() => setSaveStatus("idle"), 2000);
    return () => clearTimeout(t);
  }, [saveStatus]);

  useEffect(() => {
    if (!currentOrg) return;
    const payload = buildSavePayload();
    if (!payload) return;
    const snap = JSON.stringify(payload);
    if (!lastSavedRef.current) lastSavedRef.current = snap;
  }, [currentOrg, buildSavePayload]);

  // ── Global ESC handler for all panels ──
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const showLeftPanelRef = useRef(showLeftPanel);
  showLeftPanelRef.current = showLeftPanel;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      const rp = rightPanelRef.current;
      if (rp !== "none") {
        if (rp === "node" || rp === "edge") autoSave();
        if (rp === "node") setSelectedNodeId(null);
        if (rp === "edge") setSelectedEdgeId(null);
        setRightPanel("none");
        return;
      }
      if (isMobileRef.current && showLeftPanelRef.current) {
        setShowLeftPanel(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [autoSave, contextMenu]);

  // ── Create org ──

  const handleCreateOrg = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "新组织", description: "" }),
      });
      const data = await res.json();
      await fetchOrgList();
      setSelectedOrgId(data.id);
    } catch (e) {
      console.error("Failed to create org:", e);
    }
  }, [apiBaseUrl, fetchOrgList]);

  const handleCreateFromTemplate = useCallback(async (templateId: string) => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/from-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId }),
      });
      const data = await res.json();
      await fetchOrgList();
      setSelectedOrgId(data.id);
      setShowTemplates(false);
    } catch (e) {
      console.error("Failed to create from template:", e);
    }
  }, [apiBaseUrl, fetchOrgList]);

  const [confirmDeleteOrgId, setConfirmDeleteOrgId] = useState<string | null>(null);

  const handleDeleteOrg = useCallback(async (orgId: string) => {
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}`, { method: "DELETE" });
      if (selectedOrgId === orgId) {
        setSelectedOrgId(null);
        setCurrentOrg(null);
        setNodes([]);
        setEdges([]);
        setRightPanel("none");
      }
      fetchOrgList();
    } catch (e) {
      console.error("Failed to delete org:", e);
    } finally {
      setConfirmDeleteOrgId(null);
    }
  }, [apiBaseUrl, selectedOrgId, fetchOrgList, setNodes, setEdges]);

  // ── Node management ──

  const handleAddNode = useCallback(() => {
    if (!currentOrg || !newNodeTitle.trim()) return;
    const newId = `node_${Date.now().toString(36)}`;
    setNodes((prev) => {
      const newNode: OrgNodeData = {
        id: newId,
        role_title: newNodeTitle.trim(),
        role_goal: "",
        role_backstory: "",
        agent_source: "local",
        agent_profile_id: null,
        position: getNextNodePosition(prev),
        level: 0,
        department: newNodeDept.trim(),
        custom_prompt: "",
        identity_dir: null,
        mcp_servers: [],
        skills: [],
        skills_mode: "all",
        preferred_endpoint: null,
        max_concurrent_tasks: 1,
        timeout_s: 300,
        can_delegate: true,
        can_escalate: true,
        can_request_scaling: true,
        is_clone: false,
        clone_source: null,
        external_tools: [],
        ephemeral: false,
        frozen_by: null,
        frozen_reason: null,
        frozen_at: null,
        avatar: null,
        status: "idle",
      };
      return [...prev, orgNodeToFlowNode(newNode)];
    });
    setSelectedNodeId(newId);
    setSelectedEdgeId(null);
    setRightPanel("node");
    setPropsTab("overview");
    setNewNodeTitle("");
    setNewNodeDept("");
    setShowNewNodeForm(false);
  }, [currentOrg, newNodeTitle, newNodeDept, setNodes]);

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((prev) => prev.filter((n) => n.id !== selectedNodeId));
    setEdges((prev) => prev.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    setRightPanel("none");
  }, [selectedNodeId, setNodes, setEdges]);

  // ── Edge connection ──

  const onConnect: OnConnect = useCallback(
    (params: Connection) => {
      const edgeId = `edge_${Date.now().toString(36)}`;
      const newEdge: Edge = {
        id: edgeId,
        source: params.source!,
        target: params.target!,
        type: "default",
        style: { stroke: EDGE_COLORS.hierarchy, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.hierarchy },
        data: {
          id: edgeId,
          source: params.source,
          target: params.target,
          edge_type: "hierarchy",
          label: "",
          bidirectional: true,
          priority: 0,
          bandwidth_limit: 60,
        },
      };
      setEdges((prev) => addEdge(newEdge, prev));
      autoSave();
    },
    [setEdges, autoSave],
  );

  // ── Node click ──

  const onNodeClick = useCallback((_: any, node: Node) => {
    if (selectedNodeId && selectedNodeId !== node.id) autoSave();
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setPropsTab("overview");
    setRightPanel("node");
  }, [liveMode, selectedNodeId, autoSave]);

  const onEdgeClick = useCallback((_: any, edge: Edge) => {
    if (selectedNodeId || selectedEdgeId) autoSave();
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
    setRightPanel("edge");
  }, [selectedNodeId, selectedEdgeId, autoSave]);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setContextMenu(null);
    if (rightPanel === "node" || rightPanel === "edge" || rightPanel === "org") {
      autoSave();
      setOrgBlackboardOpen(false);
      setRightPanel("none");
    }
  }, [rightPanel, autoSave]);

  const onNodeDragStop = useCallback(() => {
    autoSave();
  }, [autoSave]);

  const fitCanvasToViewport = useCallback(() => {
    reactFlowRef.current?.fitView({
      padding: 0.16,
      duration: 260,
      includeHiddenNodes: false,
    });
    setContextMenu(null);
  }, []);

  // ── Fetch node detail when selected in live mode ──
  useEffect(() => {
    if (!selectedNodeId || !currentOrg || !liveMode) {
      setNodeEvents([]);
      setNodeSchedules([]);
      setNodeMessages([]);
      setNodeThinking([]);
      return;
    }
    const fetchNodeDetail = async () => {
      try {
        const [eventsRes, schedulesRes, msgsRes, thinkingRes] = await Promise.all([
          safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/events?actor=${selectedNodeId}&limit=20`),
          safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/nodes/${selectedNodeId}/schedules`),
          safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/messages?from_node=${selectedNodeId}&limit=20`),
          safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/nodes/${selectedNodeId}/thinking?limit=30`),
        ]);
        if (eventsRes.ok) setNodeEvents(await eventsRes.json());
        if (schedulesRes.ok) setNodeSchedules(await schedulesRes.json());
        if (msgsRes.ok) {
          const data = await msgsRes.json();
          setNodeMessages(data.messages || data || []);
        }
        if (thinkingRes.ok) {
          const data = await thinkingRes.json();
          setNodeThinking(data.timeline || []);
        }
      } catch (e) {
        console.error("Failed to fetch node detail:", e);
      }
    };
    fetchNodeDetail();
    const interval = setInterval(fetchNodeDetail, 8000);
    return () => clearInterval(interval);
  }, [selectedNodeId, currentOrg, liveMode, apiBaseUrl]);

  // ── Fetch org stats in live mode ──
  useEffect(() => {
    if (!currentOrg || !liveMode) { setOrgStats(null); return; }
    const fetchStats = async () => {
      try {
        const res = await safeFetch(`${apiBaseUrl}/api/orgs/${currentOrg.id}/stats`);
        if (res.ok) setOrgStats(await res.json());
      } catch (e) { /* ignore */ }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 8000);
    return () => clearInterval(interval);
  }, [currentOrg, liveMode, apiBaseUrl]);

  // Node tasks fetch moved to OrgNodeInspector

  // ── Inject runtime metrics into nodes from orgStats ──
  useEffect(() => {
    if (!orgStats?.per_node || !orgStats?.anomalies) return;
    const nodeMap = new Map<string, any>();
    for (const nd of orgStats.per_node) nodeMap.set(nd.id, nd);
    const anomalyMap = new Map<string, string>();
    for (const a of orgStats.anomalies) anomalyMap.set(a.node_id, a.message);
    setNodes((prev) =>
      prev.map((n) => {
        const rt = nodeMap.get(n.id);
        if (!rt) return n;
        return {
          ...n,
          data: {
            ...n.data,
            _runtime: {
              idle_seconds: rt.idle_seconds,
              pending_messages: rt.pending_messages,
              anomaly: anomalyMap.get(n.id) || null,
              plan_progress: rt.plan_progress,
              delegated_summary: rt.delegated_summary,
              external_tools: rt.external_tools,
              running_since: rt.running_since,
              recent_activity_ts: rt.recent_activity_ts,
              last_watchdog_action: rt.last_watchdog_action,
            },
          },
        };
      }),
    );
  }, [orgStats, setNodes]);

  useEffect(() => {
    if (viewMode !== "projects") setTaskChainFocus(null);
  }, [viewMode]);

  const onTaskChainFocusChange = useCallback(
    (focus: {
      ownerNodeId: string | null;
      waitingNodeIds: string[];
      delegatedNodeIds: string[];
      waitingReplyNodeIds: string[];
      messageRoutes: Array<{ fromNodeId: string; toNodeId: string; status: string; messageCount: number }>;
    } | null) => {
      setTaskChainFocus(focus);
    },
    [],
  );

  const flowNodes = useMemo(
    () =>
      nodes.map((n) => {
        const d = n.data as unknown as OrgNodeData;
        const focus = taskChainFocus
          ? {
              owner_node_id: taskChainFocus.ownerNodeId,
              waiting_node_ids: [...taskChainFocus.waitingNodeIds, ...taskChainFocus.waitingReplyNodeIds],
              delegated_node_ids: taskChainFocus.delegatedNodeIds,
            }
          : null;
        return {
          ...n,
          data: { ...d, _task_chain_focus: focus },
        };
      }),
    [nodes, taskChainFocus],
  );

  const flowEdges = useMemo(() => {
    const routeMap = new Map(
      (taskChainFocus?.messageRoutes || []).map((route) => [`${route.fromNodeId}->${route.toNodeId}`, route]),
    );
    return edges.map((e) => {
      const anim = edgeAnimations[e.id];
      const flowCount = liveMode ? edgeFlowCounts[e.id] : undefined;
      const baseLabel = `${(e.data as any)?.label || ""} ${flowCount && flowCount > 0 ? `(${flowCount})` : ""}`.trim() || undefined;
      const base = baseLabel ? { ...e, label: baseLabel } : e;
      const route = routeMap.get(`${e.source}->${e.target}`) || routeMap.get(`${e.target}->${e.source}`);
      let merged = base;
      if (route) {
        const focusColor =
          route.status === "waiting_reply"
            ? "#f59e0b"
            : route.status === "replied"
              ? "#8b5cf6"
              : "#06b6d4";
        const focusLabel =
          route.status === "waiting_reply"
            ? `等待回复 ${route.messageCount}`
            : route.status === "replied"
              ? `已回复 ${route.messageCount}`
              : `协作中 ${route.messageCount}`;
        merged = {
          ...base,
          animated: true,
          label: `${baseLabel || ""} ${focusLabel}`.trim(),
          style: {
            ...base.style,
            stroke: focusColor,
            strokeWidth: 3.5,
            filter: `drop-shadow(0 0 4px ${focusColor})`,
          },
          markerEnd: { ...(base.markerEnd as any), color: focusColor },
        };
      }
      if (!anim) return merged;
      return {
        ...merged,
        animated: true,
        style: { ...merged.style, stroke: anim.color, strokeWidth: 3, filter: `drop-shadow(0 0 4px ${anim.color})` },
        markerEnd: { ...(merged.markerEnd as any), color: anim.color },
      };
    });
  }, [edges, edgeAnimations, edgeFlowCounts, liveMode, taskChainFocus]);

  const handleOpenTaskInCanvas = useCallback(
    (nodeIds: string[]) => {
      const existing = nodeIds.filter((id) => nodes.some((n) => n.id === id));
      if (existing.length === 0) {
        showToast("画布中未找到相关节点", "error");
        return;
      }
      setViewMode("canvas");
      setSelectedEdgeId(null);
      setSelectedNodeId(existing[0]);
      setRightPanel("node");
      setPropsTab("overview");
      requestAnimationFrame(() => {
        const inst = reactFlowRef.current;
        if (!inst) return;
        inst.fitView({
          nodes: existing.map((id) => ({ id })),
          padding: 0.32,
          duration: 380,
        });
      });
    },
    [nodes, showToast],
  );

  // ── Selected node data ──

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    const n = nodes.find((n) => n.id === selectedNodeId);
    return n ? (n.data as unknown as OrgNodeData) : null;
  }, [selectedNodeId, nodes]);

  const updateNodeData = useCallback((field: string, value: any) => {
    if (!selectedNodeId) return;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === selectedNodeId ? { ...n, data: { ...n.data, [field]: value } } : n,
      ),
    );
  }, [selectedNodeId, setNodes]);

  // ── Selected edge data ──

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    const e = edges.find((e) => e.id === selectedEdgeId);
    if (!e) return null;
    return { ...((e.data as any) || {}), source: e.source, target: e.target, _id: e.id };
  }, [selectedEdgeId, edges]);

  const updateEdgeData = useCallback((field: string, value: any) => {
    if (!selectedEdgeId) return;
    setEdges((prev) =>
      prev.map((e) => {
        if (e.id !== selectedEdgeId) return e;
        const newData = { ...e.data, [field]: value };
        const edgeType = field === "edge_type" ? value : (e.data as any)?.edge_type;
        return {
          ...e,
          data: newData,
          style: { stroke: EDGE_COLORS[edgeType] || "var(--muted)", strokeWidth: edgeType === "hierarchy" ? 2 : 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS[edgeType] || "var(--muted)" },
          animated: edgeType === "collaborate",
          label: field === "label" ? value : (e.data as any)?.label || undefined,
        };
      }),
    );
  }, [selectedEdgeId, setEdges]);

  const handleDeleteEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    setEdges((prev) => prev.filter((e) => e.id !== selectedEdgeId));
    setSelectedEdgeId(null);
    setRightPanel("none");
  }, [selectedEdgeId, setEdges]);

  const ctxCopyNode = useCallback((nodeId: string) => {
    const n = nodes.find((n) => n.id === nodeId);
    if (n) setClipboardNode(structuredClone(n));
    setContextMenu(null);
  }, [nodes]);

  const ctxDeleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
      setRightPanel("none");
    }
    setContextMenu(null);
  }, [selectedNodeId, setNodes, setEdges]);

  const ctxDeleteEdge = useCallback((edgeId: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
    if (selectedEdgeId === edgeId) {
      setSelectedEdgeId(null);
      setRightPanel("none");
    }
    setContextMenu(null);
  }, [selectedEdgeId, setEdges]);

  const ctxReverseEdge = useCallback((edgeId: string) => {
    setEdges((prev) => prev.map((e) => {
      if (e.id !== edgeId) return e;
      return { ...e, source: e.target, target: e.source };
    }));
    setContextMenu(null);
  }, [setEdges]);

  const ctxUnfreezeNode = useCallback(async (nodeId: string) => {
    setContextMenu(null);
    if (!selectedOrgId) return;
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/${selectedOrgId}/nodes/${nodeId}/unfreeze`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      setNodes((prev) => prev.map((n) => {
        if (n.id !== nodeId) return n;
        return { ...n, data: { ...n.data, status: "idle", frozen_by: null, frozen_reason: null, frozen_at: null } };
      }));
      showToast("节点已解除冻结");
    } catch (e) {
      showToast(`解除冻结失败: ${e}`, "error");
    }
  }, [selectedOrgId, apiBaseUrl, setNodes, showToast]);

  const ctxPasteNode = useCallback(() => {
    if (!clipboardNode) return;
    const offset = 60;
    const newId = `node_${Date.now().toString(36)}`;
    const pasted = {
      ...structuredClone(clipboardNode),
      id: newId,
      position: { x: (clipboardNode.position?.x ?? 200) + offset, y: (clipboardNode.position?.y ?? 200) + offset },
      data: { ...clipboardNode.data, id: newId, role_title: `${clipboardNode.data?.role_title || "节点"} (副本)` },
      selected: false,
    };
    setNodes((prev) => [...prev, pasted]);
    setContextMenu(null);
  }, [clipboardNode, setNodes]);

  const ctxAddNodeAt = useCallback(() => {
    const newId = `node_${Date.now().toString(36)}`;
    const hasPanePosition = contextMenu?.type === "pane"
      && typeof contextMenu.flowX === "number"
      && typeof contextMenu.flowY === "number";
    const pos = hasPanePosition
      ? { x: contextMenu.flowX!, y: contextMenu.flowY! }
      : getNextNodePosition(nodes);
    const newNode: OrgNodeData = {
      id: newId, role_title: "新节点", role_goal: "", role_backstory: "",
      agent_source: "local", agent_profile_id: null, position: pos, level: 0,
      department: "", custom_prompt: "", identity_dir: null, mcp_servers: [], skills: [],
      skills_mode: "all", preferred_endpoint: null, max_concurrent_tasks: 1, timeout_s: 0,
      can_delegate: true, can_escalate: true, can_request_scaling: true, is_clone: false,
      clone_source: null, external_tools: [], ephemeral: false, frozen_by: null,
      frozen_reason: null, frozen_at: null, avatar: null, status: "idle",
    };
    setNodes((prev) => [...prev, orgNodeToFlowNode(newNode)]);
    setSelectedNodeId(newId);
    setSelectedEdgeId(null);
    setRightPanel("node");
    setPropsTab("overview");
    setContextMenu(null);
  }, [nodes, contextMenu, setNodes]);

  // ── Render ──

  if (!visible) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {currentOrg && (
        <OrgEditorTopBar
          currentOrg={currentOrg}
          setCurrentOrg={setCurrentOrg}
          showLeftPanel={showLeftPanel}
          setShowLeftPanel={setShowLeftPanel}
          isMobile={isMobile}
          saveStatus={saveStatus}
          doSaveRef={doSaveRef}
          liveMode={liveMode}
          orgStats={orgStats}
          viewMode={viewMode}
          setViewMode={setViewMode}
          autoSave={autoSave}
          handleStartOrg={handleStartOrg}
          handleStopOrg={handleStopOrg}
          layoutLocked={layoutLocked}
          setLayoutLocked={setLayoutLocked}
          saving={saving}
          handleSave={handleSave}
          rightPanel={rightPanel}
          setRightPanel={setRightPanel}
          inboxUnreadCount={inboxSummary.unreadCount}
          pendingApprovals={inboxSummary.pendingApprovals}
        />
      )}

      {/* ── Content area: Left + Canvas + Right ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      {/* ── Left Panel: Org List ── */}
      <PanelShell
        open={showLeftPanel}
        onClose={() => setShowLeftPanel(false)}
        width={240}
        maxWidth={320}
        side="left"
        isMobile={isMobile}
        style={{ overflow: "hidden" }}
      >
        <OrgListPanel
          showTemplates={showTemplates}
          setShowTemplates={setShowTemplates}
          templates={templates}
          handleCreateOrg={handleCreateOrg}
          handleCreateFromTemplate={handleCreateFromTemplate}
          orgImportRef={orgImportRef}
          handleImportOrg={handleImportOrg}
          isMobile={isMobile}
          setShowLeftPanel={setShowLeftPanel}
          orgList={orgList}
          selectedOrgId={selectedOrgId}
          setSelectedOrgId={setSelectedOrgId}
          doSave={doSave}
          confirmDeleteOrgId={confirmDeleteOrgId}
          setConfirmDeleteOrgId={setConfirmDeleteOrgId}
          handleDeleteOrg={handleDeleteOrg}
        />
      </PanelShell>

      {/* ── Center: Canvas ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Add node dialog */}
        <Dialog open={showNewNodeForm} onOpenChange={setShowNewNodeForm}>
          <DialogContent className="sm:max-w-[360px]">
            <DialogHeader>
              <DialogTitle>添加节点</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-[11px] mb-1">岗位名称 *</Label>
                <Input
                  placeholder="例如：产品经理"
                  value={newNodeTitle}
                  onChange={(e) => setNewNodeTitle(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleAddNode()}
                />
              </div>
              <div>
                <Label className="text-[11px] mb-1">部门（可选）</Label>
                <Input
                  placeholder="例如：技术部"
                  value={newNodeDept}
                  onChange={(e) => setNewNodeDept(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddNode()}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowNewNodeForm(false)}>取消</Button>
              <Button onClick={handleAddNode}>添加</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Main content: Canvas / Projects / Dashboard */}
        {currentOrg ? (
          <>
          {viewMode === "dashboard" ? (
            <div style={{ flex: 1, overflow: "hidden" }}>
              <OrgDashboard
                orgId={currentOrg.id}
                apiBaseUrl={apiBaseUrl}
                orgName={currentOrg.name}
                onNodeClick={(nodeId) => {
                  setViewMode("canvas");
                  const n = nodes.find(nd => nd.id === nodeId);
                  if (n) {
                    setSelectedNodeId(nodeId);
                    setSelectedEdgeId(null);
                    setRightPanel("node");
                    setPropsTab("overview");
                  }
                }}
              />
            </div>
          ) : viewMode === "projects" ? (
            <div style={{ flex: 1, overflow: "hidden" }}>
              {selectedOrgId ? (
                <OrgProjectBoard
                  orgId={selectedOrgId}
                  apiBaseUrl={apiBaseUrl}
                  nodes={nodes.map(n => ({ id: n.id, role_title: (n.data as any)?.role_title, avatar: (n.data as any)?.avatar }))}
                  onTaskChainFocusChange={onTaskChainFocusChange}
                  onOpenTaskInCanvas={handleOpenTaskInCanvas}
                />
              ) : (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", height: "100%" }}>
                  请先选择一个组织
                </div>
              )}
            </div>
          ) : (
          <div style={{ flex: 1, position: "relative" }} onContextMenu={(e) => e.preventDefault()}>
            <ReactFlow
              onInit={(instance) => {
                reactFlowRef.current = instance as ReactFlowInstance<Node, Edge>;
              }}
              nodes={flowNodes as Node[]}
              edges={flowEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onNodeDragStop={onNodeDragStop}
              onNodeContextMenu={(e, node) => { e.preventDefault(); e.stopPropagation(); setSelectedNodeId(node.id); setSelectedEdgeId(null); setContextMenu({ x: e.clientX, y: e.clientY, type: "node", id: node.id }); }}
              onEdgeContextMenu={(e, edge) => { e.preventDefault(); e.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedNodeId(null); setContextMenu({ x: e.clientX, y: e.clientY, type: "edge", id: edge.id }); }}
              onPaneContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const flow = reactFlowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  type: "pane",
                  id: null,
                  flowX: flow?.x,
                  flowY: flow?.y,
                });
              }}
              nodeTypes={nodeTypes}
              connectOnClick
              connectionLineStyle={{ stroke: "#6366f1", strokeWidth: 2.5, strokeDasharray: "6 3" }}
              fitView
              snapToGrid
              snapGrid={[20, 20]}
              nodesDraggable={!layoutLocked}
              nodesConnectable={!layoutLocked}
              defaultEdgeOptions={{
                type: "default",
                style: { strokeWidth: 2 },
              }}
              style={{ background: "var(--bg-app)" }}
            >
              <Background gap={20} size={1} color="var(--line)" />
              <OrgCanvasControls />
              {/* Canvas-specific toolbar */}
              <Panel position="top-left">
                <div className="org-canvas-toolbar">
                  <button className="org-cvs-btn" onClick={() => setShowNewNodeForm(true)} title="添加节点">
                    <IconPlus size={13} /> 节点
                  </button>
                  <button className="org-cvs-btn" title="自动布局" onClick={() => { setNodes(computeTreeLayout(nodes, edges)); }}>
                    <IconSitemap size={13} /> 布局
                  </button>
                  {selectedNodeId && (
                    <button className="org-cvs-btn org-cvs-btn--danger" onClick={handleDeleteNode} title="删除选中节点">
                      <IconTrash size={13} />
                    </button>
                  )}
                </div>
              </Panel>
              {!isMobile && (
                <Panel position="top-left">
                  <div className="org-edge-legend-panel">
                    <div className="org-edge-legend-panel__title">连线说明</div>
                    <div className="org-edge-legend-list">
                      {Object.entries(EDGE_COLORS).map(([type, color]) => (
                        <span key={type} className="org-edge-legend-item">
                          <span className="org-edge-legend-line" style={{ background: color }} />
                          <span>{EDGE_TYPE_LABELS[type] || type}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </Panel>
              )}

            </ReactFlow>
            {/* ── Context menu (portal to body to avoid clipping) ── */}
            {contextMenu && createPortal(
              <div
                className="org-ctx-menu"
                style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 99999 }}
                onClick={() => setContextMenu(null)}
                onContextMenu={(e) => e.preventDefault()}
              >
                {contextMenu.type === "node" && contextMenu.id && (<>
                  {liveMode && selectedOrgId && (
                    <button onClick={() => { setChatPanelNode(contextMenu.id); setRightPanel("command"); setContextMenu(null); }}>
                      <span className="org-ctx-icon">💬</span>与该节点对话
                    </button>
                  )}
                  {liveMode && selectedOrgId && (nodes.find(n => n.id === contextMenu.id)?.data as any)?.status === "frozen" && (
                    <button onClick={() => ctxUnfreezeNode(contextMenu.id!)}>
                      <span className="org-ctx-icon">🔓</span>解除冻结
                    </button>
                  )}
                  <button onClick={() => ctxCopyNode(contextMenu.id!)}>
                    <span className="org-ctx-icon">📋</span>复制节点
                  </button>
                  <button onClick={() => ctxDeleteNode(contextMenu.id!)}>
                    <span className="org-ctx-icon" style={{ color: "#ef4444" }}>🗑</span>删除节点
                  </button>
                </>)}
                {contextMenu.type === "edge" && contextMenu.id && (<>
                  <button onClick={() => ctxReverseEdge(contextMenu.id!)}>
                    <span className="org-ctx-icon">🔄</span>反转方向
                  </button>
                  <button onClick={() => ctxDeleteEdge(contextMenu.id!)}>
                    <span className="org-ctx-icon" style={{ color: "#ef4444" }}>🗑</span>删除连线
                  </button>
                </>)}
                {contextMenu.type === "pane" && (<>
                  <button onClick={() => ctxAddNodeAt()}>
                    <span className="org-ctx-icon">➕</span>添加节点
                  </button>
                  {clipboardNode && (
                    <button onClick={() => ctxPasteNode()}>
                      <span className="org-ctx-icon">📌</span>粘贴节点
                    </button>
                  )}
                  <button onClick={() => fitCanvasToViewport()}>
                    <IconMaximize2 size={13} className="org-ctx-icon" />适应窗口
                  </button>
                  <button onClick={() => { setNodes(computeTreeLayout(nodes, edges)); setContextMenu(null); }}>
                    <span className="org-ctx-icon">🔀</span>自动布局
                  </button>
                </>)}
              </div>,
              document.body
            )}
            {/* ── Canvas bottom: live activity feed ── */}
            {liveMode && layoutLocked && orgStats && (() => {
              const anomalies: any[] = orgStats.anomalies || [];
              const nodeLabel = (id: string | null | undefined) => {
                if (!id) return "?";
                const nd = nodes.find(n => n.id === id);
                return (nd?.data as any)?.role_title || id.slice(0, 6) || id || "?";
              };

              const parseAnomaly = (a: any) => {
                const message = String(a?.message || "");
                const idleMatch = message.match(/空闲超过\s*(\d+)\s*分钟/);
                if (idleMatch) return `${a.role_title || nodeLabel(a.node_id)} 已空闲 ${idleMatch[1]} 分钟`;
                if (/阻塞|失败|异常|报错|超时/i.test(message)) return `${a.role_title || nodeLabel(a.node_id)} ${message}`;
                return `${a.role_title || nodeLabel(a.node_id)} ${message}`;
              };
              const anomalySummary = anomalies.slice(0, 5).map((a: any) => parseAnomaly(a)).join(" · ");

              const activityItems = activityFeed.slice(0, 160).map((entry) => {
                const d = entry.data || {};
                const actorNodeId = d.node_id || d.from_node || d.accepted_by || d.rejected_by || d.source_node || null;
                const actor = actorNodeId ? nodeLabel(actorNodeId) : "系统";
                const detailText = String(d.task || d.current_task || d.message || d.content || d.summary || d.reason || d.error || d.result || "").trim();
                const base = {
                  key: entry.id,
                  time: fmtTime(entry.time),
                  actorNodeId,
                  actor,
                  badge: "事件",
                  badgeClass: "",
                  summary: entry.event,
                  detail: detailText,
                };
                if (entry.event === "org:node_status") {
                  const status = d.status || "busy";
                  return {
                    ...base,
                    badge: status === "error" ? "异常" : status === "idle" ? "完成" : "执行中",
                    badgeClass: status === "error" ? "org-feed-state-badge--danger" : status === "idle" ? "org-feed-state-badge--done" : "org-feed-state-badge--busy",
                    summary: status === "idle"
                      ? `${actor} 完成当前处理`
                      : status === "error"
                        ? `${actor} 执行异常`
                        : `${actor} 开始执行任务`,
                  };
                }
                if (entry.event === "org:task_delegated") {
                  return {
                    ...base,
                    badge: "分派",
                    badgeClass: "org-feed-state-badge--busy",
                    summary: `${nodeLabel(d.from_node)} 向 ${nodeLabel(d.to_node)} 分派任务`,
                  };
                }
                if (entry.event === "org:task_delivered") {
                  return {
                    ...base,
                    badge: "交付",
                    badgeClass: "org-feed-state-badge--busy",
                    summary: `${nodeLabel(d.from_node)} 向 ${nodeLabel(d.to_node)} 交付结果`,
                  };
                }
                if (entry.event === "org:task_accepted") {
                  return {
                    ...base,
                    badge: "通过",
                    badgeClass: "org-feed-state-badge--done",
                    summary: `${nodeLabel(d.accepted_by)} 验收通过`,
                  };
                }
                if (entry.event === "org:task_rejected") {
                  return {
                    ...base,
                    badge: "打回",
                    badgeClass: "org-feed-state-badge--danger",
                    summary: `${nodeLabel(d.rejected_by)} 打回任务`,
                  };
                }
                if (entry.event === "org:task_timeout") {
                  return {
                    ...base,
                    badge: "超时",
                    badgeClass: "org-feed-state-badge--warn",
                    summary: `${actor} 处理超时`,
                  };
                }
                if (entry.event === "org:task_complete") {
                  return {
                    ...base,
                    badge: "完成",
                    badgeClass: "org-feed-state-badge--done",
                    summary: `${actor} 完成任务`,
                  };
                }
                if (entry.event === "org:message") {
                  return {
                    ...base,
                    badge: "消息",
                    summary: `${nodeLabel(d.from_node)} 向 ${nodeLabel(d.to_node)} 发送消息`,
                  };
                }
                if (entry.event === "org:blackboard_update") {
                  return {
                    ...base,
                    badge: "黑板",
                    summary: `${actor} 更新黑板`,
                  };
                }
                if (entry.event === "org:heartbeat_start" || entry.event === "org:heartbeat_done") {
                  return {
                    ...base,
                    badge: "巡检",
                    summary: entry.event === "org:heartbeat_start" ? "组织开始心跳巡检" : "组织完成心跳巡检",
                  };
                }
                if (entry.event === "org:broadcast") {
                  return {
                    ...base,
                    badge: "广播",
                    summary: `${actor} 发起广播`,
                  };
                }
                return base;
              });

              return (
                <div className="org-live-feed">
                  <div className="org-live-feed-header">
                    <div className="org-feed-summary org-feed-summary--plain">
                      <span className="org-feed-summary__badge org-feed-summary__badge--plain">运行记录</span>
                      <span className="org-feed-summary__text org-feed-summary__text--plain">
                        这里会按时间持续累计组织动作，可滚动翻阅历史，查看每个节点正在做什么、做过什么以及结果如何。
                      </span>
                      {anomalies.length > 0 && (
                        <span
                          className="org-feed-summary__badge org-feed-summary__badge--warn-inline"
                          title={anomalySummary}
                        >
                          需关注 {anomalies.length}
                        </span>
                      )}
                    </div>
                    {selectedOrgId && rightPanel !== "command" && (
                      <button
                        onClick={() => { setChatPanelNode(null); setRightPanel("command"); }}
                        className="org-chat-fab org-chat-fab--inline"
                        title="打开组织指挥台"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        <span className="org-chat-fab-label">指挥台</span>
                      </button>
                    )}
                  </div>
                  <div className="org-feed-card org-feed-card--log">
                    <div className="org-feed-card__body org-feed-card__body--log">
                      {activityItems.length === 0 ? (
                        <div className="org-feed-empty">暂无运行记录。组织启动后，这里会持续累积每个节点的执行、分派、交付、消息与异常历史。</div>
                      ) : activityItems.map((item) => (
                        <div
                          key={item.key}
                          className={`org-feed-log-row ${item.actorNodeId ? "org-feed-log-row--clickable" : ""}`}
                          onClick={item.actorNodeId ? () => {
                            setSelectedNodeId(item.actorNodeId);
                            setSelectedEdgeId(null);
                            setRightPanel("node");
                            setPropsTab("overview");
                          } : undefined}
                        >
                          <div className="org-feed-log-row__meta">
                            <span className="org-feed-time">{item.time}</span>
                            <span className="org-feed-who">{item.actor}</span>
                            <span className={`org-feed-state-badge ${item.badgeClass || "org-feed-state-badge--neutral"}`}>{item.badge}</span>
                          </div>
                          <div className="org-feed-log-row__content">
                            <div className="org-feed-log-row__summary">{item.summary}</div>
                            {item.detail ? <div className="org-feed-log-row__detail">{item.detail}</div> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
          )}

          {/* ═══ Floating Chat FAB (always visible when org selected) ═══ */}
          {selectedOrgId && rightPanel !== "command" && !(liveMode && layoutLocked && orgStats) && (
            <button
              onClick={() => { setChatPanelNode(null); setRightPanel("command"); }}
              className="org-chat-fab"
              title="打开组织指挥台"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="org-chat-fab-label">指挥台</span>
            </button>
          )}

          {/* ═══ Slide-out Chat Panel ═══ */}
          {selectedOrgId && (
            <>
              <div
                className="org-chat-overlay"
                onClick={() => setRightPanel("none")}
                style={{ display: rightPanel === "command" ? undefined : "none" }}
              />
              <div className="org-chat-slide" style={{ display: rightPanel === "command" ? undefined : "none" }}>
                <OrgChatPanel
                  orgId={selectedOrgId}
                  nodeId={chatPanelNode}
                  apiBaseUrl={apiBaseUrl}
                  showHeader
                  title={chatPanelNode
                    ? `对话 · ${(nodes.find(n => n.id === chatPanelNode)?.data as any)?.role_title || chatPanelNode}`
                    : `${currentOrg?.name || "组织"} · 指挥台`}
                  onClose={() => setRightPanel("none")}
                />
              </div>
            </>
          )}

          <style>{`
            .org-chat-fab {
              position: absolute; right: 18px; bottom: 18px; z-index: 40;
              display: flex; align-items: center; gap: 8px;
              width: fit-content;
              padding: 12px 20px; border: none; border-radius: 16px;
              background: linear-gradient(135deg, #3b82f6, #6366f1) !important;
              color: #ffffff !important; cursor: pointer; font-size: 13px; font-weight: 600;
              box-shadow: 0 4px 20px rgba(99,102,241,0.4), 0 0 40px rgba(99,102,241,0.15);
              transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
              animation: org-fab-in 0.4s cubic-bezier(0.34,1.56,0.64,1);
              -webkit-text-fill-color: #ffffff !important;
            }
            .org-chat-fab--inline {
              position: relative;
              right: auto;
              bottom: auto;
              z-index: auto;
              padding: 10px 16px;
              border-radius: 14px;
              margin-left: auto;
              animation: none;
              box-shadow: 0 4px 16px rgba(99,102,241,0.26);
              flex-shrink: 0;
            }
            @keyframes org-fab-in {
              from { transform: scale(0.5) translateY(20px); opacity: 0; }
              to { transform: scale(1) translateY(0); opacity: 1; }
            }
            .org-chat-fab:hover {
              transform: translateY(-2px) scale(1.02);
              background: linear-gradient(135deg, #2563eb, #4f46e5) !important;
              color: #ffffff !important;
              -webkit-text-fill-color: #ffffff !important;
              box-shadow: 0 6px 28px rgba(99,102,241,0.6), 0 0 60px rgba(99,102,241,0.25);
            }
            .org-chat-fab:active { transform: scale(0.97); }
            .org-chat-fab svg { stroke: #ffffff !important; }
            .org-chat-fab-label { letter-spacing: 0.5px; color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; }

            .org-chat-overlay {
              position: absolute; inset: 0; z-index: 80;
              background: rgba(0,0,0,0.3);
              backdrop-filter: blur(2px);
              animation: org-overlay-in 0.2s ease;
            }
            @keyframes org-overlay-in { from { opacity: 0; } to { opacity: 1; } }

            .org-chat-slide {
              position: absolute; top: 0; right: 0; bottom: 0; z-index: 90;
              width: min(420px, 85%);
              background: var(--bg-app);
              border-left: 1px solid var(--line);
              box-shadow: -8px 0 30px rgba(0,0,0,0.3);
              animation: org-slide-in 0.3s cubic-bezier(0.4,0,0.2,1);
            }
            @keyframes org-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

            .org-ctx-menu {
              min-width: 160px;
              background: var(--card-bg);
              border: 1px solid var(--line);
              border-radius: 10px;
              padding: 4px;
              box-shadow: 0 8px 30px rgba(0,0,0,0.35), 0 0 1px rgba(255,255,255,0.1);
              backdrop-filter: blur(12px);
              animation: org-ctx-in 0.15s ease;
            }
            @keyframes org-ctx-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
            .org-ctx-menu button {
              display: flex; align-items: center; gap: 8px; width: 100%;
              padding: 8px 12px; border: none; border-radius: 7px;
              background: transparent; color: var(--text);
              font-size: 13px; cursor: pointer; text-align: left;
              transition: background 0.15s;
            }
            .org-ctx-menu button:hover { background: var(--hover-bg); }
            .org-ctx-icon { width: 18px; text-align: center; flex-shrink: 0; font-size: 14px; }
            .org-edge-legend-panel {
              margin-top: 46px;
              display: flex;
              flex-direction: column;
              gap: 8px;
              min-width: 210px;
              padding: 10px 12px;
              border: 1px solid rgba(51,65,85,0.14);
              border-radius: 12px;
              background: color-mix(in srgb, var(--card-bg) 50%, transparent);
              box-shadow: 0 6px 18px rgba(15,23,42,0.08);
              backdrop-filter: blur(8px);
            }
            .org-edge-legend-panel__title {
              font-size: 11px;
              font-weight: 700;
              color: var(--text);
              letter-spacing: 0.03em;
            }
            .org-edge-legend-list {
              display: flex;
              flex-wrap: wrap;
              gap: 8px 12px;
            }
            .org-edge-legend-item {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              font-size: 11px;
              color: var(--muted);
              white-space: nowrap;
            }
            .org-edge-legend-line {
              display: inline-block;
              width: 18px;
              height: 3px;
              border-radius: 999px;
              flex-shrink: 0;
            }

            /* ── Top bar layout ── */
            .org-topbar {
              height: 52px;
              border-bottom: 1px solid var(--line);
              display: grid;
              grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
              align-items: center;
              padding: 0 10px;
              background: var(--bg-app);
              flex-shrink: 0;
              gap: 10px;
            }
            .org-topbar-left {
              display: flex; align-items: center; gap: 6px;
              flex-shrink: 1; min-width: 0; overflow: hidden;
            }
            .org-topbar-center {
              display: flex;
              justify-content: center;
              min-width: 0;
            }
            .org-topbar-name {
              height: 32px;
              border: none; background: transparent;
              font-weight: 600; font-size: 14px;
              outline: none; width: 110px;
              color: var(--text);
              padding: 0 10px;
              border-radius: 10px;
              transition: background 0.15s, box-shadow 0.15s;
            }
            .org-topbar-name:hover { background: rgba(99,102,241,0.05); }
            .org-topbar-name:focus {
              background: rgba(99,102,241,0.06);
              box-shadow: inset 0 0 0 1px rgba(99,102,241,0.22);
            }
            .org-topbar-status {
              font-size: 10px; padding: 2px 6px; border-radius: 4px;
              font-weight: 600; white-space: nowrap; flex-shrink: 0;
            }
            .org-topbar-stats {
              display: flex; gap: 5px; align-items: center;
              font-size: 10px; color: var(--muted);
              flex-shrink: 0;
            }
            .org-health-dot {
              width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
            }

            /* ── View tabs (center) ── */
            .org-topbar-tabs {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              padding: 4px;
              border: 1px solid color-mix(in srgb, var(--line) 88%, transparent);
              border-radius: 14px;
              background: color-mix(in srgb, var(--card-bg) 76%, var(--bg-subtle) 24%);
              box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
              flex-shrink: 0;
            }
            .org-view-tab {
              display: inline-flex; align-items: center; gap: 5px;
              height: 34px; padding: 0 16px;
              border: none; background: transparent;
              border-radius: 10px;
              color: var(--muted); font-size: 13px; font-weight: 500;
              cursor: pointer; white-space: nowrap;
              transition: color 0.15s, background-color 0.15s, box-shadow 0.15s, transform 0.15s;
            }
            .org-view-tab:hover {
              color: var(--text);
              background: color-mix(in srgb, var(--bg-subtle) 68%, transparent);
            }
            .org-view-tab[data-state="on"],
            .org-view-tab--active {
              color: var(--primary) !important;
              font-weight: 600;
              background: color-mix(in srgb, var(--card-bg) 92%, white 8%) !important;
              box-shadow: 0 1px 2px rgba(15,23,42,0.06), inset 0 0 0 1px color-mix(in srgb, var(--primary) 18%, transparent);
            }
            .org-view-tab[data-state="on"] svg,
            .org-view-tab--active svg {
              color: var(--primary);
            }

            /* ── Right actions ── */
            .org-topbar-right {
              display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-shrink: 0;
              min-width: 0;
            }
            .org-topbar-live-pill {
              display: inline-flex;
              justify-content: center;
              align-items: center;
              width: 32px;
              min-width: 32px;
              height: 32px;
              border: 1px solid var(--line);
              border-radius: 0.5rem;
              background: var(--background, var(--bg-app));
              color: var(--muted);
              transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
            }
            .org-topbar-live-pill--active {
              color: var(--primary);
              background: rgba(99,102,241,0.08);
              border-color: rgba(99,102,241,0.25);
              box-shadow: inset 0 0 0 1px rgba(99,102,241,0.08);
            }
            .org-topbar-live-pill--active svg {
              animation: orgLivePulse 1.5s ease-in-out infinite;
            }
            @keyframes orgLivePulse {
              0%, 100% { transform: scale(1); opacity: 0.85; }
              50% { transform: scale(1.12); opacity: 1; }
            }
            .org-tb-btn {
              display: inline-flex; align-items: center; gap: 4px;
              height: 28px; padding: 0 8px; border-radius: 6px;
              border: 1px solid var(--line);
              background: transparent;
              color: var(--text);
              font-size: 12px; cursor: pointer; white-space: nowrap;
              transition: background 0.15s, color 0.15s, border-color 0.15s;
              position: relative;
            }
            .org-tb-btn:hover {
              background: var(--hover-bg);
              border-color: rgba(99,102,241,0.3);
            }
            .org-tb-btn:active { background: rgba(99,102,241,0.2); }
            .org-tb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .org-tb-btn--active {
              color: var(--primary); font-weight: 600;
              background: rgba(99,102,241,0.12);
              border-color: rgba(99,102,241,0.35);
            }
            .org-tb-btn--ok { color: #22c55e; border-color: rgba(34,197,94,0.3); }
            .org-tb-btn--ok:hover { background: rgba(34,197,94,0.12); }
            .org-tb-btn--danger { color: #ef4444; border-color: rgba(239,68,68,0.3); }
            .org-tb-btn--danger:hover { background: rgba(239,68,68,0.12); }
            .org-notif-dot {
              position: absolute; top: 3px; right: 3px;
              width: 5px; height: 5px; border-radius: 50%;
              background: var(--ok, #22c55e);
              animation: orgDotPulse 1.5s ease-in-out infinite;
            }

            /* ── Node handle styling ── */
            .org-handle {
              width: 10px !important;
              height: 10px !important;
              background: #6366f1 !important;
              border: 2px solid #fff !important;
              border-radius: 50% !important;
              transition: all 0.2s ease;
            }
            .org-handle:hover {
              width: 14px !important;
              height: 14px !important;
              background: #4f46e5 !important;
              box-shadow: 0 0 0 3px rgba(99,102,241,0.3), 0 0 8px rgba(99,102,241,0.4) !important;
            }

            /* ── Canvas toolbar (inside ReactFlow) ── */
            .org-canvas-toolbar {
              display: flex; align-items: center; gap: 4px;
              background: var(--card-bg);
              border: 1px solid var(--line);
              border-radius: 8px; padding: 3px 4px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.2);
              backdrop-filter: blur(8px);
            }
            .org-cvs-btn {
              display: inline-flex; align-items: center; gap: 4px;
              height: 26px; padding: 0 10px; border-radius: 5px;
              border: none; background: transparent;
              color: var(--text); font-size: 11px;
              cursor: pointer; white-space: nowrap;
              transition: background 0.15s;
            }
            .org-cvs-btn:hover { background: rgba(99,102,241,0.15); }
            .org-cvs-btn--danger { color: #ef4444; }
            .org-cvs-btn--danger:hover { background: rgba(239,68,68,0.15); }

            .org-tb-stats {
              display: flex; gap: 6px; align-items: center;
              font-size: 10px; color: var(--muted);
              padding: 0 4px;
            }

            /* ── Canvas bottom live activity feed ── */
            .org-live-feed {
              position: absolute; left: 0; right: 0; bottom: 0;
              z-index: 5;
              display: flex;
              flex-direction: column;
              gap: 10px;
              min-height: 250px;
              max-height: 360px;
              background: linear-gradient(to top, color-mix(in srgb, var(--bg-app) 94%, #ffffff 6%) 92%, color-mix(in srgb, var(--bg-app) 82%, transparent));
              padding: 12px 16px 14px;
              border-top: 1px solid rgba(51,65,85,0.12);
              box-shadow: 0 -10px 28px rgba(15,23,42,0.10);
              scrollbar-width: thin;
            }
            .org-live-feed-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }
            .org-feed-card {
              min-width: 0;
              height: 100%;
              border: 1px solid rgba(51,65,85,0.14);
              border-radius: 14px;
              background: color-mix(in srgb, var(--bg-app) 94%, #ffffff 6%);
              box-shadow: 0 8px 22px rgba(15,23,42,0.10);
            }
            .org-feed-card--log {
              flex: 1 1 auto;
              min-height: 0;
              display: flex;
              flex-direction: column;
            }
            .org-feed-card__title {
              padding: 12px 14px 10px;
              border-bottom: 1px solid rgba(51,65,85,0.12);
              font-size: 12px;
              font-weight: 700;
              letter-spacing: 0.03em;
              color: var(--text);
            }
            .org-feed-card__body {
              display: flex;
              flex-direction: column;
              gap: 0;
              height: 100%;
              min-height: 190px;
              overflow-y: auto;
              padding: 6px 14px 10px;
            }
            .org-feed-card__body--log {
              min-height: 230px;
              padding-top: 8px;
            }
            .org-feed-empty {
              padding: 18px 2px;
              font-size: 12px;
              color: var(--muted);
            }
            .org-feed-summary {
              display: flex;
              align-items: center;
              gap: 8px;
              margin-bottom: 0;
              padding: 8px 10px;
              border-radius: 10px;
              font-size: 12px;
              flex: 1 1 auto;
              min-width: 0;
            }
            .org-feed-summary--warn {
              background: rgba(245,158,11,0.12);
              border: 1px solid rgba(245,158,11,0.18);
            }
            .org-feed-summary--plain {
              background: rgba(59,130,246,0.12);
              border: 1px solid rgba(59,130,246,0.18);
            }
            .org-feed-summary__badge {
              display: inline-flex;
              align-items: center;
              height: 22px;
              padding: 0 8px;
              border-radius: 999px;
              background: rgba(245,158,11,0.14);
              color: #b45309;
              font-weight: 700;
              flex-shrink: 0;
            }
            .org-feed-summary__badge--plain {
              background: rgba(59,130,246,0.12);
              color: #1d4ed8;
            }
            .org-feed-summary__badge--warn-inline {
              margin-left: auto;
              background: rgba(245,158,11,0.14);
              color: #b45309;
            }
            .org-feed-summary__text {
              min-width: 0;
              color: #92400e;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .org-feed-summary__text--plain {
              color: #1e40af;
            }
            .org-feed-section-title {
              margin: 4px 0 6px;
              font-size: 11px;
              font-weight: 700;
              letter-spacing: 0.04em;
              color: var(--muted);
              text-transform: uppercase;
            }
            .org-feed-item {
              display: flex; align-items: center; gap: 6px;
              padding: 3px 0; font-size: 12px; color: var(--text);
              line-height: 1.4; white-space: nowrap;
              border-bottom: 1px solid rgba(51,65,85,0.15);
            }
            .org-feed-item:last-child { border-bottom: none; }
            .org-feed-ok { }
            .org-feed-err .org-feed-label { color: #ef4444; }
            .org-feed-log-row {
              display: flex;
              align-items: flex-start;
              gap: 8px;
              min-width: 0;
              padding: 10px 0;
              border-bottom: 1px solid rgba(51,65,85,0.12);
              font-size: 12px;
            }
            .org-feed-log-row:last-child {
              border-bottom: none;
            }
            .org-feed-log-row--clickable {
              cursor: pointer;
            }
            .org-feed-log-row--clickable:hover .org-feed-who,
            .org-feed-log-row--clickable:hover .org-feed-log-row__summary {
              color: var(--primary);
            }
            .org-feed-log-row {
              display: flex;
              align-items: flex-start;
              gap: 8px;
            }
            .org-feed-log-row__meta {
              flex: 0 0 196px;
              min-width: 196px;
              max-width: 196px;
              display: grid;
              grid-template-columns: 48px 78px 56px;
              align-items: center;
              gap: 8px;
              padding-top: 1px;
              justify-items: start;
            }
            .org-feed-log-row__summary,
            .org-feed-log-row__detail {
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: normal;
              display: -webkit-box;
              -webkit-line-clamp: 2;
              -webkit-box-orient: vertical;
            }
            .org-feed-log-row__content {
              flex: 1 1 auto;
              min-width: 0;
              display: flex;
              flex-direction: column;
              gap: 2px;
            }
            .org-feed-log-row__summary {
              font-weight: 600;
              color: var(--text);
              line-height: 1.45;
            }
            .org-feed-log-row__detail {
              color: var(--muted);
              line-height: 1.45;
            }
            .org-feed-time {
              font-size: 11px; color: var(--muted); font-family: monospace;
              line-height: 1;
              text-align: left;
            }
            .org-feed-who {
              width: 100%;
              min-width: 0;
              font-weight: 600; color: var(--text);
              transition: color 0.15s;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              text-align: left;
            }
            .org-feed-state-badge {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              height: 20px;
              padding: 0 8px;
              border-radius: 999px;
              font-size: 11px;
              font-weight: 600;
              flex-shrink: 0;
              min-width: 52px;
              text-align: center;
            }
            .org-feed-state-badge--neutral {
              background: rgba(100,116,139,0.12);
              color: #475569;
            }
            .org-feed-state-badge--busy {
              background: rgba(59,130,246,0.12);
              color: #2563eb;
            }
            .org-feed-state-badge--done {
              background: rgba(34,197,94,0.14);
              color: #15803d;
            }
            .org-feed-state-badge--warn {
              background: rgba(245,158,11,0.14);
              color: #b45309;
            }
            .org-feed-state-badge--danger {
              background: rgba(239,68,68,0.12);
              color: #dc2626;
            }
            @media (max-width: 980px) {
              .org-chat-fab {
                right: 12px;
                bottom: 12px;
              }
              .org-edge-legend-panel {
                display: none;
              }
              .org-live-feed {
                max-height: 420px;
              }
              .org-feed-log-row {
                flex-direction: column;
                gap: 4px;
              }
              .org-feed-log-row__meta {
                flex: none;
                min-width: 0;
                max-width: none;
                width: 100%;
                grid-template-columns: 48px minmax(0, 1fr) 56px;
              }
              .org-feed-summary {
                flex-wrap: wrap;
              }
              .org-feed-summary__badge--warn-inline {
                margin-left: 0;
              }
            }

            /* ── Blackboard markdown content ── */
            .bb-entry-content { font-size: 11px; line-height: 1.5; }
            .bb-entry-content p { margin: 0 0 4px; }
            .bb-entry-content p:last-child { margin-bottom: 0; }
            .bb-entry-content h1, .bb-entry-content h2, .bb-entry-content h3,
            .bb-entry-content h4, .bb-entry-content h5, .bb-entry-content h6 {
              margin: 4px 0 2px; font-weight: 600;
            }
            .bb-entry-content h1 { font-size: 14px; }
            .bb-entry-content h2 { font-size: 13px; }
            .bb-entry-content ul, .bb-entry-content ol {
              margin: 2px 0; padding-left: 16px;
            }
            .bb-entry-content li { margin: 1px 0; }
            .bb-entry-content li::marker { color: var(--muted); }
            .bb-entry-content strong { font-weight: 600; }
            .bb-entry-content em { font-style: italic; }
            .bb-entry-content code {
              font-size: 10px; padding: 1px 3px;
              background: var(--hover-bg); border-radius: 2px;
            }
            .bb-entry-content pre {
              margin: 4px 0; padding: 4px 6px;
              background: var(--hover-bg); border-radius: 3px;
              overflow-x: auto; font-size: 10px;
            }
            .bb-entry-content pre code { padding: 0; background: none; }
            .bb-entry-content blockquote {
              margin: 4px 0; padding-left: 8px;
              border-left: 2px solid var(--line);
              color: var(--muted);
            }
            .bb-entry-content table { border-collapse: collapse; margin: 4px 0; font-size: 11px; width: 100%; }
            .bb-entry-content th, .bb-entry-content td {
              padding: 2px 6px; border: 1px solid var(--line);
            }
            .bb-entry-content th { font-weight: 600; background: var(--hover-bg); }
            .bb-entry-content hr { border: none; border-top: 1px solid var(--line); margin: 6px 0; }
            .bb-entry-content a { color: var(--primary); text-decoration: underline; }

            /* ── Save button feedback ── */
            .org-save-btn {
              transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .org-save-btn:active:not(:disabled) {
              transform: scale(0.92);
              box-shadow: 0 0 0 2px rgba(99,102,241,0.3);
            }
            .org-save-btn--saving {
              animation: orgSavePulse 0.8s ease-in-out infinite;
              pointer-events: none;
            }
            @keyframes orgSavePulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.6; }
            }

            /* ── Auto-save status indicator ── */
            .org-save-indicator {
              font-size: 10px; padding: 2px 6px; border-radius: 4px;
              transition: opacity 0.3s;
            }
            .org-save-indicator--saving { color: var(--muted); }
            .org-save-indicator--saved { color: #22c55e; }
            .org-save-indicator--error { color: #ef4444; }
          `}</style>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}
            onClick={() => { if (isMobile) setShowLeftPanel(true); }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
              <IconUsers size={48} />
              <p style={{ marginTop: 12, fontSize: 14 }}>
                {isMobile ? "点击打开组织列表" : "选择或创建一个组织开始编排"}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Right Panel: Node Properties ── */}
      <PanelShell
        open={rightPanel === "node" && !!selectedNode}
        onClose={() => { autoSave(); setSelectedNodeId(null); setRightPanel("none"); }}
        width={480}
        isMobile={isMobile}
      >
        {selectedNode && (
          <OrgNodeInspector
            selectedNode={selectedNode}
            selectedNodeId={selectedNodeId!}
            selectedOrgId={selectedOrgId}
            updateNodeData={updateNodeData}
            autoSave={autoSave}
            onClose={() => { autoSave(); setSelectedNodeId(null); setRightPanel('none'); }}
            liveMode={liveMode}
            currentOrg={currentOrg}
            apiBaseUrl={apiBaseUrl}
            nodes={nodes}
            md={md}
            setChatPanelNode={setChatPanelNode}
            setRightPanel={setRightPanel}
            setSelectedNodeId={setSelectedNodeId}
            nodeSchedules={nodeSchedules}
            nodeEvents={nodeEvents}
            nodeThinking={nodeThinking}
            orgStats={orgStats}
            agentProfiles={agentProfiles}
            availableMcpServers={availableMcpServers}
            availableSkills={availableSkills}
            propsTab={propsTab}
            setPropsTab={setPropsTab}
          />
        )}
      </PanelShell>

      {/* ── Right Panel: Edge Properties ── */}
      <PanelShell
        open={rightPanel === "edge" && !!selectedEdge}
        onClose={() => { autoSave(); setSelectedEdgeId(null); setRightPanel("none"); }}
        width={280}
        isMobile={isMobile}
      >
        {selectedEdge && (
          <OrgEdgeInspector
            selectedEdge={selectedEdge}
            nodes={nodes}
            updateEdgeData={updateEdgeData}
            handleDeleteEdge={handleDeleteEdge}
            onClose={() => { autoSave(); setSelectedEdgeId(null); setRightPanel("none"); }}
          />
        )}
      </PanelShell>

      <PanelShell
        open={rightPanel === "org" && !!currentOrg}
        onClose={() => { autoSave(); setOrgBlackboardOpen(false); setRightPanel("none"); }}
        width={480}
        isMobile={isMobile}
        style={{ overflow: "hidden" }}
      >
        {currentOrg && (
          <div className="flex h-full flex-col bg-background">
            <div className="flex items-start justify-between border-b px-4 pt-4 pb-3">
              <div>
                <div className="mb-1 text-base font-semibold">组织设置与黑板</div>
                <div className="text-xs text-muted-foreground">在同一侧栏中切换配置与组织沉淀</div>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => { autoSave(); setOrgBlackboardOpen(false); setRightPanel("none"); }}>
                <IconX size={14} />
              </Button>
            </div>
            <div className="border-b px-4 py-2">
              <div className="inline-flex rounded-xl border bg-background p-1">
                <button
                  className={`rounded-lg px-3 py-1.5 text-xs ${!orgBlackboardOpen ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  onClick={() => setOrgBlackboardOpen(false)}
                >
                  设置
                </button>
                <button
                  className={`rounded-lg px-3 py-1.5 text-xs ${orgBlackboardOpen ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  onClick={() => {
                    fetchBlackboard(currentOrg.id, bbScope);
                    setOrgBlackboardOpen(true);
                  }}
                >
                  黑板
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {orgBlackboardOpen ? (
                <OrgBlackboardPanel
                  currentOrg={currentOrg}
                  apiBaseUrl={apiBaseUrl}
                  md={md}
                  bbEntries={bbEntries}
                  setBbEntries={setBbEntries}
                  bbScope={bbScope}
                  setBbScope={setBbScope}
                  bbLoading={bbLoading}
                  fetchBlackboard={fetchBlackboard}
                  onClose={() => { autoSave(); setOrgBlackboardOpen(false); setRightPanel("none"); }}
                  embedded
                />
              ) : (
                <OrgSettingsPanel
                  currentOrg={currentOrg}
                  setCurrentOrg={setCurrentOrg}
                  autoSave={autoSave}
                  onClose={() => { autoSave(); setOrgBlackboardOpen(false); setRightPanel("none"); }}
                  liveMode={liveMode}
                  apiBaseUrl={apiBaseUrl}
                  md={md}
                  handleExportOrg={handleExportOrg}
                  handleImportOrg={handleImportOrg}
                  bbEntries={bbEntries}
                  setBbEntries={setBbEntries}
                  bbScope={bbScope}
                  setBbScope={setBbScope}
                  bbLoading={bbLoading}
                  fetchBlackboard={fetchBlackboard}
                  confirmReset={confirmReset}
                  setConfirmReset={setConfirmReset}
                  onOpenBlackboard={() => setOrgBlackboardOpen(true)}
                  embedded
                />
              )}
            </div>
          </div>
        )}
      </PanelShell>

      {/* Inbox Sidebar */}
      <PanelShell
        open={rightPanel === "inbox" && !!currentOrg}
        onClose={() => setRightPanel("none")}
        width={380}
        isMobile={isMobile}
      >
        {currentOrg && (
          <OrgInboxSidebar
            apiBaseUrl={apiBaseUrl}
            orgId={currentOrg.id}
            visible={true}
            onClose={() => setRightPanel("none")}
            onCountsChange={setInboxSummary}
          />
        )}
      </PanelShell>
      </div>{/* close content area */}

      {/* Toast notification */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          zIndex: 9999, display: "flex", alignItems: "center", gap: 6,
          padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
          color: "#fff", boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          background: toast.type === "ok" ? "var(--ok, #22c55e)" : "var(--danger, #ef4444)",
          animation: "toast-in 0.2s ease",
        }}>
          {toast.type === "ok" ? <IconCheck size={14} /> : <IconAlertCircle size={14} />}
          {toast.message}
        </div>
      )}
      <ConfirmDialog
        dialog={confirmReset ? { message: "确认重置该组织吗？将清空所有运行数据（黑板、消息、事件日志），恢复为初始状态。此操作不可撤销。", onConfirm: handleResetOrg } : null}
        onClose={() => setConfirmReset(false)}
      />
    </div>
  );
}
