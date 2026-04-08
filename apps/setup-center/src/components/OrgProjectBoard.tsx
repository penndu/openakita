/**
 * Project management board — Gantt timeline + kanban columns.
 * Full-screen layout with project selector, timeline progress, and task modals.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Check, CornerUpLeft, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import { safeFetch } from "../providers";
import { OrgAvatar } from "./OrgAvatars";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Badge } from "./ui/badge";

interface ProjectTask {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  assignee_node_id: string | null;
  priority: number;
  progress_pct: number;
  created_at: string;
  started_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  runtime_phase?: string | null;
  current_owner_node_id?: string | null;
  waiting_on_nodes?: string[];
  last_error?: string | null;
  last_event?: string | null;
  cancel_requested_at?: string | null;
  cancelled_at?: string | null;
}

interface Project {
  id: string;
  org_id: string;
  name: string;
  description: string;
  project_type: string;
  status: string;
  owner_node_id: string | null;
  tasks: ProjectTask[];
  created_at: string;
  updated_at: string;
}

interface PendingTaskDelete {
  projectId: string;
  taskId: string;
  taskTitle: string;
}

export type TaskChainFocusPayload = {
  ownerNodeId: string | null;
  waitingNodeIds: string[];
  delegatedNodeIds: string[];
  waitingReplyNodeIds: string[];
  messageRoutes: Array<{
    fromNodeId: string;
    toNodeId: string;
    status: string;
    messageCount: number;
  }>;
};

function buildTaskChainFocusFromDetail(taskDetail: any | null): TaskChainFocusPayload | null {
  if (!taskDetail) return null;
  const runtime = taskDetail.runtime || {};
  const collaboration = taskDetail.collaboration || {};
  const owner = (runtime.current_owner_node_id ?? taskDetail.current_owner_node_id ?? null) as string | null;
  const waiting = new Set<string>(
    [...(collaboration.waiting_on_nodes || []), ...(runtime.waiting_on_nodes || [])].filter(Boolean),
  );
  const delegated = new Set<string>(
    (taskDetail.child_chains || []).map((c: any) => c.node_id).filter(Boolean),
  );
  const commSummary = collaboration.communication_summary || {};
  const waitingReply = new Set<string>(
    (commSummary.routes || [])
      .filter((route: any) => route.awaiting_reply && route.to_node)
      .map((route: any) => route.to_node),
  );
  return {
    ownerNodeId: owner,
    waitingNodeIds: [...waiting],
    delegatedNodeIds: [...delegated],
    waitingReplyNodeIds: [...waitingReply],
    messageRoutes: (commSummary.routes || [])
      .filter((route: any) => route.from_node && route.to_node)
      .map((route: any) => ({
        fromNodeId: route.from_node,
        toNodeId: route.to_node,
        status: route.status || "active",
        messageCount: route.message_count || 0,
      })),
  };
}

function collectCanvasNodeIds(task: any): string[] {
  const f = buildTaskChainFocusFromDetail(task);
  const ids = new Set<string>();
  if (task?.assignee_node_id) ids.add(task.assignee_node_id);
  if (f?.ownerNodeId) ids.add(f.ownerNodeId);
  f?.waitingNodeIds.forEach((id) => ids.add(id));
  f?.delegatedNodeIds.forEach((id) => ids.add(id));
  f?.waitingReplyNodeIds.forEach((id) => ids.add(id));
  return [...ids];
}

interface OrgProjectBoardProps {
  orgId: string;
  apiBaseUrl: string;
  nodes?: Array<{ id: string; role_title?: string; avatar?: string | null }>;
  compact?: boolean;
  /** 项目视图选中任务时，将链上节点同步到编排画布高亮 */
  onTaskChainFocusChange?: (focus: TaskChainFocusPayload | null) => void;
  /** 在画布中定位并框选相关节点 */
  onOpenTaskInCanvas?: (nodeIds: string[]) => void;
}

const STATUS_META: Record<string, { label: string; color: string; order: number }> = {
  todo:        { label: "待办",   color: "#64748b", order: 0 },
  in_progress: { label: "进行中", color: "#3b82f6", order: 1 },
  delivered:   { label: "已交付", color: "#8b5cf6", order: 2 },
  rejected:    { label: "已打回", color: "#f97316", order: 3 },
  accepted:    { label: "已验收", color: "#22c55e", order: 4 },
  blocked:     { label: "已阻塞", color: "#ef4444", order: 5 },
  cancelled:   { label: "已取消", color: "#6b7280", order: 6 },
};

const COLUMNS = Object.entries(STATUS_META).map(([key, v]) => ({ key, ...v }));

const PROJECT_TYPE_LABEL: Record<string, string> = { temporary: "临时", permanent: "持续" };
const PROJECT_STATUS_LABEL: Record<string, string> = {
  planning: "规划中", active: "进行中", paused: "暂停", completed: "已完成", archived: "已归档",
};
const PROJECT_STATUS_COLOR: Record<string, string> = {
  planning: "#f59e0b", active: "#3b82f6", paused: "#94a3b8", completed: "#22c55e", archived: "#6b7280",
};

const RUNTIME_PHASE_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_children: "等待子节点",
  gathering: "汇总中",
  delivered: "已交付",
  accepted: "已验收",
  rejected: "已打回",
  failed: "失败",
  cancel_requested: "取消中",
  cancelled: "已取消",
};

function isTaskCancelling(task: ProjectTask): boolean {
  return task.runtime_phase === "cancel_requested";
}

function isTaskCancelled(task: ProjectTask): boolean {
  return task.status === "cancelled" || task.runtime_phase === "cancelled";
}

function canCancelTask(task: ProjectTask): boolean {
  if (isTaskCancelled(task) || isTaskCancelling(task)) return false;
  return (
    task.status === "in_progress" ||
    task.runtime_phase === "queued" ||
    task.runtime_phase === "running" ||
    task.runtime_phase === "waiting_children"
  );
}

export function OrgProjectBoard({
  orgId,
  apiBaseUrl,
  nodes = [],
  compact = false,
  onTaskChainFocusChange,
  onOpenTaskInCanvas,
}: OrgProjectBoardProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newProjectType, setNewProjectType] = useState("temporary");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [newTaskAssignee, setNewTaskAssignee] = useState("");
  const [dispatchingTaskId, setDispatchingTaskId] = useState<string | null>(null);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [taskDetail, setTaskDetail] = useState<any>(null);
  const [taskTimeline, setTaskTimeline] = useState<any[]>([]);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [subtasksExpanded, setSubtasksExpanded] = useState(true);
  const [taskActionMessage, setTaskActionMessage] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<"gantt" | "kanban">("gantt");
  const [projectPendingDelete, setProjectPendingDelete] = useState<Project | null>(null);
  const [taskPendingDelete, setTaskPendingDelete] = useState<PendingTaskDelete | null>(null);
  const [projectStripWidth, setProjectStripWidth] = useState<number | null>(null);
  const [projectScrollbarSize, setProjectScrollbarSize] = useState(0);
  const projectRailRef = useRef<HTMLDivElement | null>(null);
  const projectStripRef = useRef<HTMLDivElement | null>(null);
  const projectTrackRef = useRef<HTMLDivElement | null>(null);
  const projectAddRef = useRef<HTMLDivElement | null>(null);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const fetchTaskDetail = useCallback(async (taskId: string) => {
    setTaskDetailLoading(true);
    setTaskDetail(null);
    setTaskTimeline([]);
    try {
      const detailRes = await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/tasks/${taskId}`);
      if (!detailRes.ok) {
        throw new Error(`HTTP ${detailRes.status}`);
      }
      const detail = await detailRes.json();
      setTaskDetail(detail);
      setTaskTimeline(detail.timeline || []);
    } catch (e: any) {
      toast.error(e?.message || "加载任务详情失败");
    }
    setTaskDetailLoading(false);
  }, [orgId, apiBaseUrl]);

  const openTaskDetail = useCallback((task: ProjectTask) => {
    setSelectedTask(task);
    fetchTaskDetail(task.id);
  }, [fetchTaskDetail]);

  const closeTaskDetail = useCallback(() => {
    setSelectedTask(null);
    setTaskDetail(null);
    setTaskTimeline([]);
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects`);
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
        if (data.length === 0) {
          setSelectedProjectId(null);
        } else if (!selectedProjectId || !data.some((p: Project) => p.id === selectedProjectId)) {
          setSelectedProjectId(data[0].id);
        }
      }
    } catch (e: any) {
      toast.error(e?.message || "加载项目失败");
    }
    setLoading(false);
  }, [orgId, apiBaseUrl, selectedProjectId]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  useEffect(() => {
    const rail = projectRailRef.current;
    const strip = projectStripRef.current;
    const track = projectTrackRef.current;
    const add = projectAddRef.current;
    if (!rail || !strip || !track || !add) {
      setProjectStripWidth(null);
      return;
    }

    const gap = 10;
    const measureLayout = () => {
      const available = Math.max(160, rail.clientWidth - add.offsetWidth - gap);
      const content = track.scrollWidth;
      setProjectStripWidth(Math.min(content, available));
      setProjectScrollbarSize(Math.max(0, strip.offsetHeight - strip.clientHeight));
    };

    measureLayout();
    const observer = new ResizeObserver(measureLayout);
    observer.observe(rail);
    observer.observe(strip);
    observer.observe(track);
    observer.observe(add);
    window.addEventListener("resize", measureLayout);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureLayout);
    };
  }, [projects]);

  const resetProjectForm = () => {
    setNewProjectName("");
    setNewProjectDesc("");
    setNewProjectType("temporary");
    setEditingProject(null);
  };

  const openEditProject = (project: Project) => {
    setEditingProject(project);
    setNewProjectName(project.name || "");
    setNewProjectDesc(project.description || "");
    setNewProjectType(project.project_type || "temporary");
    setShowNewProject(true);
  };

  const submitProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      await safeFetch(
        editingProject
          ? `${apiBaseUrl}/api/orgs/${orgId}/projects/${editingProject.id}`
          : `${apiBaseUrl}/api/orgs/${orgId}/projects`,
        {
        method: editingProject ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProjectName,
          description: newProjectDesc,
          project_type: newProjectType,
          status: editingProject?.status ?? "active",
        }),
      });
      resetProjectForm();
      setShowNewProject(false);
      fetchProjects();
    } catch { /* ignore */ }
  };

  const createTask = async () => {
    if (!newTaskTitle.trim() || !selectedProjectId) return;
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects/${selectedProjectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTaskTitle, description: newTaskDesc, assignee_node_id: newTaskAssignee || null, status: "todo" }),
      });
      setNewTaskTitle(""); setNewTaskDesc(""); setNewTaskAssignee(""); setShowNewTask(false);
      fetchProjects();
    } catch { /* ignore */ }
  };

  const deleteProject = async (projectId: string) => {
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects/${projectId}`, { method: "DELETE" });
      if (selectedProjectId === projectId) setSelectedProjectId(null);
      fetchProjects();
    } catch { /* ignore */ }
  };

  const updateTaskStatus = async (projectId: string, taskId: string, newStatus: string) => {
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects/${projectId}/tasks/${taskId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setTaskActionMessage(`任务已更新为${STATUS_META[newStatus]?.label || newStatus}`);
      toast.success(`任务已更新为${STATUS_META[newStatus]?.label || newStatus}`);
      await fetchProjects();
      if (selectedTask?.id === taskId) await fetchTaskDetail(taskId);
    } catch (e: any) {
      toast.error(e?.message || "更新任务状态失败");
    }
  };

  const deleteTask = async (projectId: string, taskId: string) => {
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects/${projectId}/tasks/${taskId}`, { method: "DELETE" });
      if (selectedTask?.id === taskId) closeTaskDetail();
      fetchProjects();
    } catch { /* ignore */ }
  };

  const requestTaskDelete = (projectId: string, task: ProjectTask) => {
    setTaskPendingDelete({
      projectId,
      taskId: task.id,
      taskTitle: task.title || task.id,
    });
  };

  const dispatchTask = async (projectId: string, taskId: string) => {
    setDispatchingTaskId(taskId);
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects/${projectId}/tasks/${taskId}/dispatch`, { method: "POST" });
      setTaskActionMessage("任务已派发，正在进入执行队列");
      toast.success("任务已派发，正在进入执行队列");
      await fetchProjects();
      if (selectedTask?.id === taskId) await fetchTaskDetail(taskId);
    } catch (e: any) {
      toast.error(e?.message || "任务派发失败");
    }
    finally { setDispatchingTaskId(null); }
  };

  const cancelTask = async (projectId: string, taskId: string) => {
    setCancellingTaskId(taskId);
    try {
      await safeFetch(`${apiBaseUrl}/api/orgs/${orgId}/projects/${projectId}/tasks/${taskId}/cancel`, { method: "POST" });
      setTaskActionMessage("已发送终止请求，正在取消任务链");
      toast.success("已发送终止请求，正在取消任务链");
      await fetchProjects();
      await fetchTaskDetail(taskId);
    } catch (e: any) {
      toast.error(e?.message || "终止任务失败");
    } finally {
      setCancellingTaskId(null);
    }
  };

  useEffect(() => {
    if (!onTaskChainFocusChange) return;
    if (!selectedTask) {
      onTaskChainFocusChange(null);
      return;
    }
    if (taskDetailLoading) return;
    if (!taskDetail) {
      onTaskChainFocusChange(null);
      return;
    }
    onTaskChainFocusChange(buildTaskChainFocusFromDetail(taskDetail));
  }, [selectedTask?.id, taskDetail, taskDetailLoading, onTaskChainFocusChange]);

  useEffect(() => {
    const activePhase = taskDetail?.runtime?.runtime_phase;
    const activeStatus = taskDetail?.status;
    const shouldRefreshDetail =
      !!selectedTask?.id &&
      !!taskDetail &&
      (activeStatus === "in_progress" ||
        activeStatus === "delivered" ||
        activePhase === "queued" ||
        activePhase === "running" ||
        activePhase === "waiting_children" ||
        activePhase === "gathering" ||
        activePhase === "cancel_requested");

    const intervalMs = shouldRefreshDetail ? 8000 : 20000;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchProjects();
      if (shouldRefreshDetail && selectedTask?.id) void fetchTaskDetail(selectedTask.id);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [
    selectedTask?.id,
    taskDetail?.runtime?.runtime_phase,
    taskDetail?.status,
    fetchTaskDetail,
    fetchProjects,
  ]);

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const tasks = selectedProject?.tasks || [];

  const projectStats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter(t => t.status === "accepted").length;
    const inProgress = tasks.filter(t => t.status === "in_progress").length;
    const delivered = tasks.filter(t => t.status === "delivered").length;
    const todo = tasks.filter(t => t.status === "todo").length;
    const blocked = tasks.filter(t => t.status === "blocked" || t.status === "rejected").length;
    const cancelled = tasks.filter(t => t.status === "cancelled").length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, done, inProgress, delivered, todo, blocked, cancelled, pct };
  }, [tasks]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--muted)" }}>
        加载中...
      </div>
    );
  }

  return (
    <div className="opb-root">
      <style>{`
        .opb-root {
          height: 100%; display: flex; flex-direction: column;
          overflow: hidden; background: var(--panel, var(--bg-app));
          font-size: 13px; color: var(--text);
          font-family: inherit; line-height: 1.45; letter-spacing: normal;
        }

        /* ── Header ── */
        .opb-project-rail {
          display: flex; align-items: stretch; gap: 10px;
          padding: 12px 16px; border-bottom: 1px solid var(--line);
          flex-shrink: 0; background: var(--panel2, var(--card-bg));
        }
        .opb-project-strip {
          min-width: 0; overflow-x: auto; scrollbar-width: thin;
          scrollbar-gutter: stable;
        }
        .opb-project-track {
          display: flex; gap: 10px; align-items: stretch; width: max-content;
        }
        .opb-project-card {
          min-width: 220px; max-width: 260px; cursor: pointer;
          min-height: 82px; height: 100%;
          border: 1px solid var(--line); background: var(--card-bg, var(--bg-app));
          transition: border-color .15s ease, box-shadow .15s ease, background-color .15s ease;
          position: relative; overflow: hidden;
          flex: 0 0 auto; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        .opb-project-card:hover {
          border-color: color-mix(in srgb, var(--primary) 28%, var(--line));
          background: color-mix(in srgb, var(--card-bg) 96%, var(--primary) 4%);
          box-shadow: 0 2px 6px rgba(15, 23, 42, 0.06);
        }
        .opb-project-card--selected {
          border-color: color-mix(in srgb, var(--primary) 55%, var(--line));
          background: color-mix(in srgb, var(--card-bg) 93%, var(--primary) 7%);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 22%, transparent), 0 1px 3px rgba(37, 99, 235, 0.08);
        }
        .opb-project-card__title {
          font-size: 14px; font-weight: 600; color: var(--text);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          line-height: 1.25;
        }
        .opb-project-card__desc {
          font-size: 11px; color: var(--muted);
          line-height: 1.35;
          display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
        }
        .opb-project-card__body {
          display: flex; flex-direction: column; gap: 6px; height: 100%;
        }
        .opb-project-card__meta {
          display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
        }
        .opb-project-card__summary {
          display: flex; flex-direction: column; gap: 2px;
        }
        .opb-project-card__stats {
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
          font-size: 10px; color: var(--muted);
        }
        .opb-project-card__stats strong {
          display: block; font-size: 12px; line-height: 1.1; color: var(--text); font-weight: 600;
          margin-top: 2px;
        }
        .opb-project-card__progress {
          height: 5px; border-radius: 999px; overflow: hidden;
          background: color-mix(in srgb, var(--bg-subtle) 76%, var(--line) 24%);
          border: 1px solid color-mix(in srgb, var(--line) 82%, transparent);
        }
        .opb-project-card__actions {
          position: absolute; top: 6px; right: 6px; z-index: 2;
          display: flex; gap: 4px;
          opacity: 0; pointer-events: none; transform: scale(0.92);
          transition: opacity .15s ease, transform .15s ease;
        }
        .opb-project-card__edit,
        .opb-project-card__delete {
          pointer-events: auto;
        }
        .opb-project-card:hover .opb-project-card__actions,
        .opb-project-card--selected .opb-project-card__actions {
          opacity: 1; pointer-events: auto; transform: scale(1);
        }
        .opb-project-add-card {
          min-width: 132px; max-width: 132px; cursor: pointer;
          min-height: 82px; height: 100%;
          border: 1px dashed color-mix(in srgb, var(--line) 90%, transparent);
          background: color-mix(in srgb, var(--card-bg) 70%, var(--bg-subtle) 30%);
          color: var(--muted);
          transition: border-color .15s ease, color .15s ease, background .15s ease;
          flex: 0 0 auto; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
        }
        .opb-project-add-card:hover {
          border-color: color-mix(in srgb, var(--primary) 45%, var(--line));
          color: var(--primary);
          background: color-mix(in srgb, var(--primary) 6%, var(--bg-app));
        }
        .opb-project-add-slot {
          flex: 0 0 auto;
          display: flex; align-items: stretch;
        }

        /* ── Stats row ── */
        .opb-stats-row {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px 12px; padding: 6px 16px; flex-wrap: wrap;
          border-bottom: 1px solid var(--line); flex-shrink: 0; font-size: 12px;
          background: color-mix(in srgb, var(--panel2, var(--card-bg)) 82%, transparent);
        }
        .opb-stats-summary {
          flex: 1 1 360px; min-width: 0;
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        }
        .opb-stats-actions {
          flex: 0 1 auto;
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          justify-content: flex-end;
        }
        .opb-view-toggle {
          gap: 4px;
          padding: 3px;
          border-radius: 12px;
          border: 1px solid color-mix(in srgb, var(--line) 88%, transparent);
          background: color-mix(in srgb, var(--card-bg) 74%, var(--bg-subtle) 26%);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
        }
        .opb-view-toggle-item {
          position: relative;
          border-radius: 9px !important;
          border: none !important;
          color: var(--muted);
          background: transparent !important;
          transition: color .15s ease, background-color .15s ease, box-shadow .15s ease, transform .15s ease;
        }
        .opb-view-toggle-item:hover {
          color: var(--text);
          background: color-mix(in srgb, var(--bg-subtle) 72%, transparent) !important;
        }
        .opb-view-toggle-item[data-state="on"],
        .opb-view-toggle-item--active {
          color: var(--primary-foreground, #fff) !important;
          background: linear-gradient(180deg, color-mix(in srgb, var(--primary) 88%, white 12%), var(--primary)) !important;
          box-shadow: 0 6px 16px rgba(37, 99, 235, 0.18), inset 0 -1px 0 rgba(255,255,255,0.12);
        }
        .opb-view-toggle-item[data-state="on"]::after,
        .opb-view-toggle-item--active::after {
          content: "";
          position: absolute;
          left: 10px;
          right: 10px;
          bottom: 3px;
          height: 2px;
          border-radius: 999px;
          background: rgba(255,255,255,0.78);
        }
        .opb-stat-chip {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500;
          background: color-mix(in srgb, var(--bg-subtle) 78%, var(--card-bg) 22%);
        }
        .opb-progress-track {
          flex: 1 1 140px; min-width: 120px; height: 8px; border-radius: 999px;
          background: color-mix(in srgb, var(--bg-subtle) 75%, var(--line) 25%);
          overflow: hidden; display: flex; margin: 0 4px;
          border: 1px solid color-mix(in srgb, var(--line) 85%, transparent);
        }
        .opb-progress-fill { height: 100%; border-radius: 999px; }

        /* ── Status badges ── */
        .opb-status-dot {
          display: inline-block; width: 7px; height: 7px;
          border-radius: 50%; flex-shrink: 0;
        }
        .opb-status-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
          white-space: nowrap;
        }

        /* ── Action buttons ── */
        .opb-act {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 2px 8px; border: none; border-radius: 4px;
          font-size: 10px; cursor: pointer; font-weight: 500;
          background: transparent; color: var(--muted); font-family: inherit;
        }
        .opb-act:hover { background: var(--bg-subtle, rgba(100,116,139,0.1)); }
        .opb-act--primary { background: #3b82f6; color: #fff; }
        .opb-act--primary:hover { background: #2563eb; }
        .opb-act--success { background: #22c55e; color: #fff; }
        .opb-act--success:hover { background: #16a34a; }
        .opb-act--danger { color: #ef4444; }
        .opb-act--danger:hover { background: rgba(239,68,68,0.1); }
        .opb-act--danger-fill { background: #ef4444; color: #fff; }
        .opb-act--danger-fill:hover { background: #dc2626; }
        .opb-act--ghost { background: rgba(59,130,246,0.1); color: #3b82f6; }
        .opb-act--ghost:hover { background: rgba(59,130,246,0.2); }

        /* ── Gantt ── */
        .opb-gantt {
          flex: 1; overflow: auto; padding: 12px 16px 16px;
          background: color-mix(in srgb, var(--panel) 88%, var(--bg-app) 12%);
        }
        .opb-gantt-row {
          display: flex; flex-direction: column; gap: 6px;
          padding: 12px 14px; cursor: pointer; margin-bottom: 10px;
          border: 1px solid color-mix(in srgb, var(--line) 90%, transparent);
          border-radius: 14px; background: var(--card-bg);
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        .opb-gantt-row:hover {
          background: color-mix(in srgb, var(--card-bg) 92%, var(--primary) 8%);
          border-color: color-mix(in srgb, var(--primary) 18%, var(--line));
        }
        .opb-gantt-board {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .opb-gantt-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          padding: 0 2px;
        }
        .opb-gantt-toolbar__title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text);
        }
        .opb-gantt-toolbar__hint {
          font-size: 11px;
          color: var(--muted);
        }
        .opb-gantt-legend {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .opb-gantt-legend-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 11px;
          color: var(--muted);
          background: color-mix(in srgb, var(--card-bg) 76%, var(--bg-subtle) 24%);
          border: 1px solid color-mix(in srgb, var(--line) 86%, transparent);
        }
        .opb-gantt-legend-bar,
        .opb-gantt-legend-fill,
        .opb-gantt-legend-marker {
          display: inline-flex;
          width: 20px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .opb-gantt-legend-bar {
          background: linear-gradient(90deg, rgba(59,130,246,0.2), rgba(59,130,246,0.08));
          border: 1px solid rgba(59,130,246,0.22);
        }
        .opb-gantt-legend-fill {
          background: linear-gradient(90deg, #3b82f6, #60a5fa);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
        }
        .opb-gantt-legend-marker {
          width: 10px;
          background: linear-gradient(180deg, #fbbf24, #f59e0b);
          box-shadow: 0 0 0 1px rgba(245,158,11,0.18);
        }
        .opb-gantt-axis {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .opb-gantt-axis__cell {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid color-mix(in srgb, var(--line) 86%, transparent);
          background: color-mix(in srgb, var(--card-bg) 80%, var(--bg-subtle) 20%);
        }
        .opb-gantt-axis__title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 11px;
          color: var(--muted);
        }
        .opb-gantt-axis__name {
          font-weight: 600;
          color: var(--text);
        }
        .opb-gantt-axis__count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 22px;
          padding: 0 6px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          background: color-mix(in srgb, var(--bg-subtle) 72%, var(--card-bg) 28%);
          color: var(--text);
        }
        .opb-gantt-axis__hint {
          font-size: 10px;
          color: var(--muted);
          line-height: 1.35;
        }
        .opb-gantt-row__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .opb-gantt-row__summary {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .opb-gantt-row__track {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding-left: 32px;
          margin-top: 4px;
        }
        .opb-gantt-row__track-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px 12px;
          flex-wrap: wrap;
          font-size: 11px;
          color: var(--muted);
        }
        .opb-gantt-row__track-badges {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .opb-gantt-row__track-title {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 600;
          color: var(--text);
        }
        .opb-gantt-row__track-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .opb-gantt-lane {
          position: relative;
          height: 24px;
          border-radius: 999px;
          overflow: hidden;
          border: 1px solid color-mix(in srgb, var(--line) 86%, transparent);
          background:
            linear-gradient(180deg, color-mix(in srgb, var(--bg-subtle) 52%, transparent), transparent 70%),
            color-mix(in srgb, var(--card-bg) 82%, var(--bg-subtle) 18%);
        }
        .opb-gantt-lane__grid {
          position: absolute;
          inset: 0;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
          padding: 0 8px;
        }
        .opb-gantt-lane__cell {
          border-right: 1px dashed color-mix(in srgb, var(--line) 62%, transparent);
          background: color-mix(in srgb, var(--bg-subtle) 46%, transparent);
        }
        .opb-gantt-lane__cell:last-child {
          border-right: none;
        }
        .opb-gantt-lane__range {
          position: absolute;
          left: 8px;
          top: 5px;
          bottom: 5px;
          border-radius: 999px;
        }
        .opb-gantt-lane__progress {
          position: absolute;
          left: 8px;
          top: 7px;
          bottom: 7px;
          border-radius: 999px;
          box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
        }
        .opb-gantt-lane__marker {
          position: absolute;
          top: 3px;
          bottom: 3px;
          width: 8px;
          border-radius: 999px;
          background: rgba(255,255,255,0.96);
          box-shadow: 0 0 0 2px rgba(255,255,255,0.45), 0 2px 8px rgba(15, 23, 42, 0.18);
          transform: translateX(-50%);
        }
        .opb-gantt-lane__labels {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
          padding: 0 8px;
          font-size: 10px;
          color: var(--muted);
        }
        .opb-gantt-lane__label {
          text-align: center;
        }
        .opb-gantt-completion__value {
          min-width: 56px;
          text-align: right;
          font-weight: 600;
          color: var(--text);
        }

        /* ── Kanban ── */
        .opb-kanban {
          flex: 1; display: flex; gap: 10px; padding: 12px 16px;
          overflow-x: auto; overflow-y: hidden;
          background: color-mix(in srgb, var(--panel) 88%, var(--bg-app) 12%);
        }
        .opb-kanban-col {
          flex: 1 1 170px; min-width: 170px; max-width: 260px;
          display: flex; flex-direction: column;
          background: color-mix(in srgb, var(--card-bg) 65%, var(--bg-subtle) 35%);
          border-radius: 14px; overflow: hidden;
          border: 1px solid color-mix(in srgb, var(--line) 85%, transparent);
        }
        .opb-kanban-col-header {
          padding: 8px 10px; display: flex; align-items: center; gap: 6px;
          flex-shrink: 0;
        }
        .opb-kanban-col-count {
          font-size: 10px; color: var(--muted);
          background: var(--bg-app); padding: 1px 6px; border-radius: 8px;
        }
        .opb-kanban-list {
          flex: 1; overflow-y: auto; padding: 4px 6px 6px;
          display: flex; flex-direction: column; gap: 4px;
        }
        .opb-kanban-card {
          padding: 8px 10px; border-radius: 8px;
          background: var(--card-bg); border: 1px solid color-mix(in srgb, var(--line) 90%, transparent);
          cursor: pointer;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        .opb-kanban-card:hover {
          border-color: color-mix(in srgb, var(--primary) 24%, var(--line));
          box-shadow: 0 4px 12px rgba(37, 99, 235, 0.08);
        }
        .opb-kanban-card__title {
          font-size: 13px; font-weight: 600; color: var(--text);
          line-height: 1.35; margin-bottom: 6px;
          word-break: break-word;
        }
        .opb-kanban-card__footer {
          display: flex; align-items: flex-start; justify-content: space-between;
          gap: 8px; flex-wrap: wrap;
        }
        .opb-kanban-card__owner {
          min-width: 0; flex: 1 1 96px;
          display: flex; align-items: center; gap: 4px;
        }
        .opb-kanban-card__owner-label {
          min-width: 0; font-size: 10px; color: var(--muted);
          line-height: 1.35; word-break: break-word;
        }
        .opb-kanban-card__actions {
          display: flex; gap: 4px; flex-wrap: wrap;
          justify-content: flex-end; margin-left: auto;
        }

        @media (max-width: 900px) {
          .opb-stats-actions {
            width: 100%;
            justify-content: flex-start;
          }
          .opb-gantt-axis {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 720px) {
          .opb-stats-row {
            padding-inline: 12px;
          }
          .opb-stats-summary {
            flex-basis: 100%;
          }
          .opb-progress-track {
            flex-basis: 100%;
            margin-inline: 0;
          }
          .opb-view-toggle {
            width: 100%;
            justify-content: stretch;
          }
          .opb-view-toggle-item {
            flex: 1 1 0;
          }
          .opb-gantt-row__header {
            flex-direction: column;
          }
          .opb-gantt-row__track {
            padding-left: 0;
          }
          .opb-gantt-axis,
          .opb-gantt-lane__labels {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .opb-kanban {
            padding-inline: 12px;
          }
          .opb-kanban-card__footer {
            flex-direction: column;
            align-items: stretch;
          }
          .opb-kanban-card__actions {
            width: 100%;
            margin-left: 0;
            justify-content: flex-start;
          }
        }

        /* ── Empty state ── */
        .opb-empty {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 16px;
          color: var(--muted);
        }

        /* ── Detail panel ── */
        .opb-detail-overlay {
          position: absolute; inset: 0; z-index: 100;
          display: flex; background: rgba(0,0,0,0.3);
        }
        .opb-detail-panel {
          width: min(440px, 100%); margin-left: auto;
          background: var(--bg-app); border-left: 1px solid var(--line);
          box-shadow: -4px 0 16px rgba(0,0,0,0.15);
          display: flex; flex-direction: column; overflow: hidden;
        }
      `}</style>

      {projects.length > 0 && (
        <div ref={projectRailRef} className="opb-project-rail">
          <div
            ref={projectStripRef}
            className="opb-project-strip"
            style={{ width: projectStripWidth ? `${projectStripWidth}px` : undefined }}
            onWheel={(e) => {
              const el = e.currentTarget;
              if (el.scrollWidth <= el.clientWidth) return;
              if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
              e.preventDefault();
              el.scrollLeft += e.deltaY;
            }}
          >
            <div ref={projectTrackRef} className="opb-project-track">
              {projects.map((project) => {
                const total = project.tasks.length;
                const done = project.tasks.filter((t) => t.status === "accepted").length;
                const selected = project.id === selectedProjectId;
                return (
                  <Card
                    key={project.id}
                    className={`opb-project-card py-0 ${selected ? "opb-project-card--selected" : ""}`}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div className="opb-project-card__actions">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opb-project-card__edit text-muted-foreground hover:bg-primary/10 hover:text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditProject(project);
                        }}
                        title={`编辑项目 ${project.name}`}
                        aria-label={`编辑项目 ${project.name}`}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opb-project-card__delete text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setProjectPendingDelete(project);
                        }}
                        title={`删除项目 ${project.name}`}
                        aria-label={`删除项目 ${project.name}`}
                      >
                        <X />
                      </Button>
                    </div>
                    <CardContent className="px-3 py-3">
                      <div className="opb-project-card__body">
                        <div className="opb-project-card__meta">
                          <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px] font-medium">
                            <span className="opb-status-dot" style={{ background: PROJECT_STATUS_COLOR[project.status] || "#3b82f6" }} />
                            {PROJECT_STATUS_LABEL[project.status] || project.status}
                          </Badge>
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
                            {PROJECT_TYPE_LABEL[project.project_type] || project.project_type}
                          </Badge>
                        </div>
                        <div className="opb-project-card__summary">
                          <div className="opb-project-card__title">{project.name}</div>
                          <div className="opb-project-card__desc">{project.description || "暂无项目描述"}</div>
                        </div>
                        <div className="opb-project-card__stats">
                          <div>
                            任务
                            <strong>{total}</strong>
                          </div>
                          <div>
                            完成
                            <strong>{done}</strong>
                          </div>
                          <div>
                            进度
                            <strong>{total > 0 ? Math.round((done / total) * 100) : 0}%</strong>
                          </div>
                        </div>
                        <div className="opb-project-card__progress">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${total > 0 ? Math.round((done / total) * 100) : 0}%`,
                              background: "linear-gradient(90deg, var(--primary), color-mix(in srgb, var(--primary) 78%, white))",
                            }}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
          <div
            ref={projectAddRef}
            className="opb-project-add-slot"
            style={{ paddingBottom: projectScrollbarSize ? `${projectScrollbarSize}px` : undefined }}
          >
            <Card className="opb-project-add-card py-0" onClick={() => {
              resetProjectForm();
              setShowNewProject(true);
            }}>
              <CardContent className="flex h-full flex-col items-center justify-center gap-2 px-3 py-3 text-center">
                <span className="text-lg leading-none">+</span>
                <span className="text-xs font-medium">新项目</span>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ── Stats row ── */}
      {selectedProject && (
        <>
          <div className="opb-stats-row">
            <div className="opb-stats-summary">
              {projectStats.total > 0 ? (<>
                <span className="opb-stat-chip">
                  共 <strong>{projectStats.total}</strong>
                </span>
                {projectStats.inProgress > 0 && (
                  <span className="opb-stat-chip" style={{ color: "#3b82f6" }}>
                    <span className="opb-status-dot" style={{ background: "#3b82f6", width: 6, height: 6 }} />
                    进行中 {projectStats.inProgress}
                  </span>
                )}
                {projectStats.done > 0 && (
                  <span className="opb-stat-chip" style={{ color: "#22c55e" }}>
                    <span className="opb-status-dot" style={{ background: "#22c55e", width: 6, height: 6 }} />
                    已完成 {projectStats.done}
                  </span>
                )}
                {projectStats.blocked > 0 && (
                  <span className="opb-stat-chip" style={{ color: "#ef4444" }}>
                    <span className="opb-status-dot" style={{ background: "#ef4444", width: 6, height: 6 }} />
                    异常 {projectStats.blocked}
                  </span>
                )}
                {projectStats.cancelled > 0 && (
                  <span className="opb-stat-chip" style={{ color: "#6b7280" }}>
                    <span className="opb-status-dot" style={{ background: "#6b7280", width: 6, height: 6 }} />
                    已取消 {projectStats.cancelled}
                  </span>
                )}

                <div className="opb-progress-track">
                  {projectStats.done > 0 && <div className="opb-progress-fill" style={{ width: `${(projectStats.done / projectStats.total) * 100}%`, background: "#22c55e" }} />}
                  {projectStats.delivered > 0 && <div className="opb-progress-fill" style={{ width: `${(projectStats.delivered / projectStats.total) * 100}%`, background: "#8b5cf6" }} />}
                  {projectStats.inProgress > 0 && <div className="opb-progress-fill" style={{ width: `${(projectStats.inProgress / projectStats.total) * 100}%`, background: "#3b82f6" }} />}
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, minWidth: 32, textAlign: "right" }}>{projectStats.pct}%</span>
              </>) : (
                <span style={{ color: "var(--muted)", fontSize: 12 }}>暂无任务</span>
              )}
            </div>

            <div className="opb-stats-actions">
              <ToggleGroup type="single" variant="outline" value={viewTab}
                onValueChange={v => { if (v) setViewTab(v as "gantt" | "kanban"); }}
                className="opb-view-toggle h-auto">
                <ToggleGroupItem value="gantt" className={`opb-view-toggle-item text-xs px-3 h-7 ${viewTab === "gantt" ? "opb-view-toggle-item--active" : ""}`}>
                  进度图
                </ToggleGroupItem>
                <ToggleGroupItem value="kanban" className={`opb-view-toggle-item text-xs px-3 h-7 ${viewTab === "kanban" ? "opb-view-toggle-item--active" : ""}`}>
                  看板
                </ToggleGroupItem>
              </ToggleGroup>
              <Button size="sm" className="h-7 text-xs" onClick={() => setShowNewTask(true)}>
                + 新任务
              </Button>
            </div>
          </div>
          {taskActionMessage && (
            <div
              style={{
                margin: "0 16px 10px",
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--primary) 20%, var(--line))",
                background: "color-mix(in srgb, var(--primary) 6%, var(--card-bg))",
                color: "var(--text)",
                fontSize: 12,
              }}
            >
              {taskActionMessage}
            </div>
          )}
        </>
      )}

      {/* ── Main content ── */}
      {selectedProject ? (
        viewTab === "gantt" ? (
          <GanttView
            tasks={tasks}
            nodeMap={nodeMap}
            onTaskClick={openTaskDetail}
            onStatusChange={(tid, st) => updateTaskStatus(selectedProject.id, tid, st)}
            onCancel={(tid) => cancelTask(selectedProject.id, tid)}
            onDispatch={(tid) => dispatchTask(selectedProject.id, tid)}
            onDelete={(task) => requestTaskDelete(selectedProject.id, task)}
            dispatchingTaskId={dispatchingTaskId}
            cancellingTaskId={cancellingTaskId}
          />
        ) : (
          <KanbanView
            tasks={tasks}
            nodeMap={nodeMap}
            onTaskClick={openTaskDetail}
            onStatusChange={(tid, st) => updateTaskStatus(selectedProject.id, tid, st)}
            onCancel={(tid) => cancelTask(selectedProject.id, tid)}
            onDispatch={(tid) => dispatchTask(selectedProject.id, tid)}
            onDelete={(task) => requestTaskDelete(selectedProject.id, task)}
            dispatchingTaskId={dispatchingTaskId}
            cancellingTaskId={cancellingTaskId}
          />
        )
      ) : (
        <div className="opb-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
            <path d="M3 3h7l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
            <line x1="12" y1="10" x2="12" y2="14"/><line x1="10" y1="12" x2="14" y2="12"/>
          </svg>
          <span style={{ fontSize: 14 }}>还没有项目</span>
          <span style={{ fontSize: 12 }}>创建一个项目来管理组织的任务和进度</span>
          <Button onClick={() => setShowNewProject(true)}>创建第一个项目</Button>
        </div>
      )}

      {/* ── New Project Modal ── */}
      <Dialog open={showNewProject} onOpenChange={(open) => {
        setShowNewProject(open);
        if (!open) resetProjectForm();
      }}>
        <DialogContent className="sm:max-w-md" onOpenAutoFocus={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{editingProject ? "编辑项目" : "新建项目"}</DialogTitle>
            <DialogDescription className="sr-only">
              {editingProject ? "编辑当前组织项目" : "创建一个新的组织项目"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 grid gap-2">
                <Label htmlFor="project-name">项目名称 *</Label>
                <Input id="project-name" placeholder="例如：Q2 产品迭代" value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && submitProject()} />
              </div>
              <div className="grid gap-2">
                <Label>项目类型</Label>
                <ToggleGroup type="single" variant="outline" value={newProjectType}
                  onValueChange={v => { if (v) setNewProjectType(v as "temporary" | "permanent"); }}
                  className="h-9">
                  {(["temporary", "permanent"] as const).map(t => (
                    <ToggleGroupItem key={t} value={t}
                      className={`flex-1 ${newProjectType === t ? "!bg-primary !text-primary-foreground !border-primary" : ""}`}>
                      {PROJECT_TYPE_LABEL[t]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="project-desc">项目描述</Label>
              <Textarea id="project-desc" placeholder="项目目标和范围..."
                value={newProjectDesc} onChange={e => setNewProjectDesc(e.target.value)}
                className="min-h-[80px] resize-y" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowNewProject(false);
              resetProjectForm();
            }}>取消</Button>
            <Button onClick={submitProject}>{editingProject ? "保存" : "创建"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New Task Modal ── */}
      <Dialog open={showNewTask} onOpenChange={setShowNewTask}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建任务</DialogTitle>
            <DialogDescription className="sr-only">为当前项目创建新任务</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="task-title">任务标题 *</Label>
              <Input id="task-title" placeholder="例如：设计首页原型" value={newTaskTitle}
                onChange={e => setNewTaskTitle(e.target.value)} autoFocus
                onKeyDown={e => e.key === "Enter" && createTask()} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="task-desc">任务描述</Label>
              <Textarea id="task-desc" placeholder="任务详细说明..."
                value={newTaskDesc} onChange={e => setNewTaskDesc(e.target.value)}
                className="min-h-[60px] resize-y" />
            </div>
            <div className="grid gap-2">
              <Label>指派给</Label>
              <Select value={newTaskAssignee || "__none__"} onValueChange={v => setNewTaskAssignee(v === "__none__" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="未分配" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">未分配</SelectItem>
                  {nodes.map(n => (
                    <SelectItem key={n.id} value={n.id}>{n.role_title || n.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewTask(false)}>取消</Button>
            <Button onClick={createTask}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!projectPendingDelete} onOpenChange={(open) => { if (!open) setProjectPendingDelete(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目？</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {projectPendingDelete ? `确定删除项目「${projectPendingDelete.name}」？\n此操作不可恢复，项目下的任务也会一并删除。` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (projectPendingDelete) {
                  deleteProject(projectPendingDelete.id);
                }
                setProjectPendingDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!taskPendingDelete} onOpenChange={(open) => { if (!open) setTaskPendingDelete(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除任务？</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {taskPendingDelete ? `确定删除任务「${taskPendingDelete.taskTitle}」？\n此操作不可恢复。` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (taskPendingDelete) {
                  deleteTask(taskPendingDelete.projectId, taskPendingDelete.taskId);
                }
                setTaskPendingDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Task Detail Panel ── */}
      {selectedTask && (
        <div className="opb-detail-overlay" onClick={closeTaskDetail}>
          <div className="opb-detail-panel" onClick={e => e.stopPropagation()}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>任务详情</span>
              <div className="flex items-center gap-1 shrink-0">
                {onOpenTaskInCanvas && taskDetail && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    type="button"
                    onClick={() => onOpenTaskInCanvas(collectCanvasNodeIds(taskDetail))}
                  >
                    在画布中定位
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" onClick={closeTaskDetail}>×</Button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
              {taskDetailLoading ? (
                <div style={{ color: "var(--muted)", fontSize: 12, padding: 24 }}>加载中...</div>
              ) : taskDetail ? (
                <TaskDetailContent
                  task={taskDetail} timeline={taskTimeline} nodeMap={nodeMap}
                  subtasksExpanded={subtasksExpanded} setSubtasksExpanded={setSubtasksExpanded}
                  onAncestorClick={(t: any) => { setSelectedTask(t); fetchTaskDetail(t.id); }}
                  statusLabel={(s: string) => STATUS_META[s]?.label || s}
                />
              ) : (
                <div style={{ color: "var(--muted)", fontSize: 12, padding: 24 }}>无法加载任务详情</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ Gantt View ═══════════════════ */

const GANTT_FLOW_STAGES = [
  { key: "backlog", label: "待分派", hint: "还未指定执行人" },
  { key: "assigned", label: "已分派", hint: "已明确负责人" },
  { key: "working", label: "执行中", hint: "正在处理任务" },
  { key: "done", label: "交付/完成", hint: "已交付或验收" },
] as const;

function getTaskDisplayProgress(task: Pick<ProjectTask, "status" | "progress_pct">) {
  const raw = Math.min(100, Math.max(0, task.progress_pct ?? 0));
  return task.status === "accepted" || task.status === "delivered" ? 100 : raw;
}

function getTaskFlowStage(task: ProjectTask) {
  const progress = getTaskDisplayProgress(task);
  const hasAssignee = !!task.assignee_node_id;

  if (isTaskCancelled(task)) {
    return { stageKey: "done", stageIndex: 3, stageProgress: 1, label: "已取消", progress: 0 };
  }
  if (isTaskCancelling(task)) {
    return { stageKey: "working", stageIndex: 2, stageProgress: Math.max(progress / 100, 0.58), label: "取消中", progress };
  }
  if (task.status === "accepted") {
    return { stageKey: "done", stageIndex: 3, stageProgress: 1, label: "已完成", progress };
  }
  if (task.status === "delivered") {
    return { stageKey: "done", stageIndex: 3, stageProgress: 0.7, label: "待验收", progress };
  }
  if (task.status === "rejected") {
    return { stageKey: "working", stageIndex: 2, stageProgress: Math.max(progress / 100, 0.72), label: "打回重做", progress };
  }
  if (task.status === "blocked") {
    return { stageKey: "working", stageIndex: 2, stageProgress: Math.max(progress / 100, 0.45), label: "阻塞中", progress };
  }
  if (task.status === "in_progress") {
    return { stageKey: "working", stageIndex: 2, stageProgress: Math.max(progress / 100, 0.12), label: "执行中", progress };
  }
  if (hasAssignee) {
    return { stageKey: "assigned", stageIndex: 1, stageProgress: Math.max(progress / 100, 0.28), label: "已分派", progress };
  }
  return { stageKey: "backlog", stageIndex: 0, stageProgress: 0.35, label: "待分派", progress };
}

function getTaskFlowMetrics(task: ProjectTask) {
  const flow = getTaskFlowStage(task);
  const segmentWidth = 100 / GANTT_FLOW_STAGES.length;
  const fillPct = Math.min(100, Math.max(8, flow.stageIndex * segmentWidth + flow.stageProgress * segmentWidth));
  const rangePct = Math.max(segmentWidth, (flow.stageIndex + 1) * segmentWidth);
  return {
    ...flow,
    fillPct,
    rangePct,
    markerPct: Math.min(99.2, Math.max(4, fillPct)),
  };
}

function GanttView({
  tasks, nodeMap, onTaskClick, onStatusChange, onCancel, onDispatch, onDelete, dispatchingTaskId, cancellingTaskId,
}: {
  tasks: ProjectTask[];
  nodeMap: Map<string, { id: string; role_title?: string; avatar?: string | null }>;
  onTaskClick: (t: ProjectTask) => void;
  onStatusChange: (tid: string, status: string) => void;
  onCancel: (tid: string) => void;
  onDispatch: (tid: string) => void;
  onDelete: (task: ProjectTask) => void;
  dispatchingTaskId: string | null;
  cancellingTaskId: string | null;
}) {
  const sorted = useMemo(() =>
    [...tasks].sort((a, b) => {
      const oa = STATUS_META[a.status]?.order ?? 9;
      const ob = STATUS_META[b.status]?.order ?? 9;
      if (oa !== ob) return oa - ob;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }),
    [tasks]
  );

  const stageCounts = useMemo(() => {
    const counts = Object.fromEntries(GANTT_FLOW_STAGES.map((stage) => [stage.key, 0])) as Record<string, number>;
    for (const task of tasks) {
      counts[getTaskFlowStage(task).stageKey] += 1;
    }
    return counts;
  }, [tasks]);

  return (
    <div className="opb-gantt">
      {sorted.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          暂无任务，点击「+ 新任务」开始
        </div>
      ) : (
        <div className="opb-gantt-board">
          <div className="opb-gantt-toolbar">
            <div>
              <div className="opb-gantt-toolbar__title">任务推进进度图</div>
              <div className="opb-gantt-toolbar__hint">蓝色轨道表示流程推进，橙色节点表示当前阶段位置，右侧百分比仅作整体进度参考。</div>
            </div>
            <div className="opb-gantt-legend">
              <span className="opb-gantt-legend-item">
                <span className="opb-gantt-legend-bar" />
                流程范围
              </span>
              <span className="opb-gantt-legend-item">
                <span className="opb-gantt-legend-fill" />
                当前阶段位置
              </span>
              <span className="opb-gantt-legend-item">
                <span className="opb-gantt-legend-marker" />
                当前阶段节点
              </span>
            </div>
          </div>

          <div className="opb-gantt-axis">
            {GANTT_FLOW_STAGES.map((stage) => (
              <div key={stage.key} className="opb-gantt-axis__cell">
                <div className="opb-gantt-axis__title">
                  <span className="opb-gantt-axis__name">{stage.label}</span>
                  <span className="opb-gantt-axis__count">{stageCounts[stage.key] ?? 0}</span>
                </div>
                <div className="opb-gantt-axis__hint">{stage.hint}</div>
              </div>
            ))}
          </div>

          {sorted.map((task) => {
            const meta = STATUS_META[task.status] || { label: task.status, color: "#64748b" };
            const assignee = task.assignee_node_id ? nodeMap.get(task.assignee_node_id) : null;
            const flow = getTaskFlowMetrics(task);

            return (
              <Card key={task.id} className="opb-gantt-row gap-0 py-0" onClick={() => onTaskClick(task)}>
                <CardContent className="px-4 py-4">
                  <div className="opb-gantt-row__header">
                    <div className="opb-gantt-row__summary">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <OrgAvatar avatarId={(assignee as any)?.avatar || null} size={24} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{task.title}</span>
                            <span className="opb-status-badge" style={{ background: meta.color + "18", color: meta.color, fontSize: 10, padding: "1px 6px" }}>
                              {meta.label}
                            </span>
                            {task.runtime_phase && task.runtime_phase !== task.status && (
                              <Badge variant="outline" className="h-5 px-2 text-[10px]">
                                {RUNTIME_PHASE_LABEL[task.runtime_phase] || task.runtime_phase}
                              </Badge>
                            )}
                            <Badge variant="outline" className="h-5 px-2 text-[10px]">
                              {flow.label}
                            </Badge>
                          </div>
                          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>
                            {assignee ? (assignee.role_title || assignee.id) : "未分配"}
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, opacity: 0.68 }}>#{task.id.slice(0, 8)}</span>
                          </div>
                        </div>
                      </div>

                      {task.description && (
                        <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", paddingLeft: 32 }}>
                          {task.description}
                        </div>
                      )}
                    </div>

                    <div style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {task.status === "todo" && (
                          <button data-slot="opb" className="opb-act opb-act--primary"
                            onClick={() => onDispatch(task.id)} disabled={dispatchingTaskId === task.id}>
                            {dispatchingTaskId === task.id ? "…" : "派发"}
                          </button>
                        )}
                        {(canCancelTask(task) || isTaskCancelling(task)) && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-6 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => onCancel(task.id)}
                            title="中止"
                            disabled={cancellingTaskId === task.id || isTaskCancelling(task)}
                          >
                            {cancellingTaskId === task.id || isTaskCancelling(task) ? "取消中…" : "中止"}
                          </Button>
                        )}
                        {task.status === "delivered" && (
                          <>
                            <Button size="xs" className="h-6 px-2" onClick={() => onStatusChange(task.id, "accepted")}>
                              <Check />
                              验收
                            </Button>
                            <Button variant="destructive" size="xs" className="h-6 px-2" onClick={() => onStatusChange(task.id, "rejected")}>
                              <CornerUpLeft />
                              打回
                            </Button>
                          </>
                        )}
                        {(task.status === "rejected" || task.status === "blocked") && (
                          <button data-slot="opb" className="opb-act opb-act--ghost"
                            onClick={() => onDispatch(task.id)} disabled={dispatchingTaskId === task.id}>
                            {dispatchingTaskId === task.id ? "…" : "重新派发"}
                          </button>
                        )}
                        <Button variant="ghost" size="xs" className="h-6 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => onDelete(task)}
                          title="删除任务">删除</Button>
                      </div>
                    </div>
                  </div>

                  <div className="opb-gantt-row__track">
                    <div className="opb-gantt-row__track-meta">
                      <div className="opb-gantt-row__track-badges">
                        <Badge variant="secondary" className="h-5 px-2 text-[10px]">
                          当前阶段：{flow.label}
                        </Badge>
                        <Badge variant="outline" className="h-5 px-2 text-[10px]">
                          负责人：{assignee ? (assignee.role_title || assignee.id) : "待分配"}
                        </Badge>
                      </div>
                      <span className="opb-gantt-completion__value" aria-label={`完成度 ${flow.progress}%`}>
                        完成度 {flow.progress}%
                      </span>
                    </div>

                    <div className="opb-gantt-row__track-title">
                      <span className="opb-gantt-row__track-dot" style={{ background: "#3b82f6" }} />
                      阶段进度轨道
                      <span style={{ color: "var(--muted)", fontWeight: 400 }}>· 橙色节点表示当前阶段</span>
                    </div>
                    <div className="opb-gantt-lane">
                      <div className="opb-gantt-lane__grid" aria-hidden="true">
                        {GANTT_FLOW_STAGES.map((stage) => (
                          <span key={`${task.id}-${stage.key}`} className="opb-gantt-lane__cell" />
                        ))}
                      </div>
                      <div
                        className="opb-gantt-lane__range"
                        style={{
                          width: `calc(${flow.rangePct}% - 8px)`,
                          background: "linear-gradient(90deg, rgba(59,130,246,0.18), rgba(59,130,246,0.08))",
                        }}
                      />
                      <div
                        className="opb-gantt-lane__progress"
                        style={{
                          width: `calc(${flow.fillPct}% - 8px)`,
                          background: "linear-gradient(90deg, #2563eb, #3b82f6)",
                        }}
                      />
                      <span
                        className="opb-gantt-lane__marker"
                        style={{
                          left: `calc(${flow.markerPct}% - 4px)`,
                          border: "2px solid #f59e0b",
                        }}
                      />
                    </div>

                    <div className="opb-gantt-lane__labels" aria-hidden="true">
                      {GANTT_FLOW_STAGES.map((stage) => (
                        <span key={`${task.id}-${stage.key}-label`} className="opb-gantt-lane__label">{stage.label}</span>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ Kanban View ═══════════════════ */

function KanbanView({
  tasks, nodeMap, onTaskClick, onStatusChange, onCancel, onDispatch, onDelete, dispatchingTaskId, cancellingTaskId,
}: {
  tasks: ProjectTask[];
  nodeMap: Map<string, { id: string; role_title?: string; avatar?: string | null }>;
  onTaskClick: (t: ProjectTask) => void;
  onStatusChange: (tid: string, status: string) => void;
  onCancel: (tid: string) => void;
  onDispatch: (tid: string) => void;
  onDelete: (task: ProjectTask) => void;
  dispatchingTaskId: string | null;
  cancellingTaskId: string | null;
}) {
  return (
    <div className="opb-kanban">
      {COLUMNS.map(col => {
        const colTasks = tasks.filter(t => t.status === col.key);
        return (
          <div key={col.key} className="opb-kanban-col">
            <div className="opb-kanban-col-header" style={{ borderBottom: `2px solid ${col.color}` }}>
              <span className="opb-status-dot" style={{ background: col.color }} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{col.label}</span>
              <span className="opb-kanban-col-count">{colTasks.length}</span>
            </div>
            <div className="opb-kanban-list">
              {colTasks.map(task => {
                const assignee = task.assignee_node_id ? nodeMap.get(task.assignee_node_id) : null;
                return (
                  <div key={task.id} className="opb-kanban-card" onClick={() => onTaskClick(task)}>
                    <div className="opb-kanban-card__title">{task.title}</div>
                    <div className="opb-kanban-card__footer">
                      <div className="opb-kanban-card__owner">
                        <OrgAvatar avatarId={(assignee as any)?.avatar || null} size={16} />
                        <span className="opb-kanban-card__owner-label">{assignee ? (assignee.role_title || assignee.id) : "未分配"}</span>
                      </div>
                      <div className="opb-kanban-card__actions" onClick={e => e.stopPropagation()}>
                        {col.key === "todo" && (
                          <button data-slot="opb" className="opb-act opb-act--primary"
                            onClick={() => onDispatch(task.id)} disabled={dispatchingTaskId === task.id}>
                            {dispatchingTaskId === task.id ? "…" : "派发"}
                          </button>
                        )}
                        {(canCancelTask(task) || isTaskCancelling(task)) && (<>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-6 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => onCancel(task.id)}
                            disabled={cancellingTaskId === task.id || isTaskCancelling(task) || !canCancelTask(task)}
                          >
                            {cancellingTaskId === task.id || isTaskCancelling(task) ? "取消中…" : "中止"}
                          </Button>
                        </>)}
                        {col.key === "delivered" && (<>
                          <Button size="xs" className="h-6 px-2" onClick={() => onStatusChange(task.id, "accepted")} title="验收">
                            <Check />
                            验收
                          </Button>
                          <Button variant="destructive" size="xs" className="h-6 px-2" onClick={() => onStatusChange(task.id, "rejected")} title="打回">
                            <CornerUpLeft />
                            打回
                          </Button>
                        </>)}
                        {(col.key === "rejected" || col.key === "blocked") && (
                          <button data-slot="opb" className="opb-act opb-act--ghost"
                            onClick={() => onDispatch(task.id)} disabled={dispatchingTaskId === task.id}>
                            {dispatchingTaskId === task.id ? "…" : "↻"}
                          </button>
                        )}
                        <Button variant="ghost" size="xs" className="h-6 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => onDelete(task)}>删除</Button>
                      </div>
                    </div>
                    {task.runtime_phase && task.runtime_phase !== task.status && (
                      <div className="mt-2">
                        <Badge variant="outline" className="h-5 px-2 text-[10px]">
                          {RUNTIME_PHASE_LABEL[task.runtime_phase] || task.runtime_phase}
                        </Badge>
                      </div>
                    )}
                    {(task.progress_pct ?? 0) > 0 && (task.progress_pct ?? 0) < 100 && (
                      <div style={{
                        marginTop: 8,
                        height: 8,
                        borderRadius: 999,
                        background: "color-mix(in srgb, var(--bg-subtle) 76%, var(--line) 24%)",
                        overflow: "hidden",
                        border: "1px solid color-mix(in srgb, var(--line) 82%, transparent)",
                      }}>
                        <div style={{
                          height: "100%",
                          borderRadius: 999,
                          background: `linear-gradient(90deg, ${col.color}, ${col.color}cc)`,
                          width: `${task.progress_pct}%`,
                        }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════ Task Detail Content ═══════════════════ */

function TaskDetailContent({
  task, timeline, nodeMap, subtasksExpanded, setSubtasksExpanded, onAncestorClick, statusLabel,
}: {
  task: any; timeline: any[];
  nodeMap: Map<string, { id: string; role_title?: string; avatar?: string | null }>;
  subtasksExpanded: boolean; setSubtasksExpanded: (v: boolean) => void;
  onAncestorClick: (t: any) => void; statusLabel: (s: string) => string;
}) {
  const assignee = task.assignee_node_id ? nodeMap.get(task.assignee_node_id) : null;
  const delegatedBy = task.delegated_by ? nodeMap.get(task.delegated_by) : null;
  const fmt = (s: string | null | undefined) => s ? new Date(s).toLocaleString("zh-CN") : "-";
  const meta = STATUS_META[task.status] || { label: task.status, color: "#64748b" };
  const progress = getTaskDisplayProgress(task);
  const runtime = task.runtime || {};
  const collaboration = task.collaboration || {};
  const currentOwner = runtime.current_owner_node_id ? nodeMap.get(runtime.current_owner_node_id) : null;
  const waitingNodes: string[] = collaboration.waiting_on_nodes || runtime.waiting_on_nodes || [];
  const childChains: any[] = task.child_chains || [];
  const recentMessages: any[] = collaboration.recent_messages || [];
  const communicationSummary = collaboration.communication_summary || {};
  const communicationRoutes: any[] = communicationSummary.routes || [];

  return (
    <div className="flex flex-col gap-3 text-xs">
      {(task.ancestors?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span>父任务:</span>
          {(task.ancestors || []).map((a: any, i: number) => (
            <span key={a.id} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/60">/</span>}
              <Button variant="link" size="xs" className="h-auto px-0 text-xs text-primary" onClick={() => onAncestorClick(a)}>
                {a.title || a.id}
              </Button>
            </span>
          ))}
        </div>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="gap-3 px-4 pt-4 pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-normal text-[10px] text-muted-foreground">
              #{task.id}
            </Badge>
            <Badge variant="secondary" className="gap-1 border-0" style={{ background: meta.color + "18", color: meta.color }}>
              <span className="opb-status-dot" style={{ background: meta.color }} />
              {meta.label}
            </Badge>
          </div>
          <CardTitle className="text-xl leading-tight">{task.title}</CardTitle>
          {task.description ? (
            <CardDescription className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
              {task.description}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4 px-4 py-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">进度</span>
              <span className="font-semibold">{progress}%</span>
            </div>
            <div
              className="h-2.5 overflow-hidden rounded-full border"
              style={{
                background: "color-mix(in srgb, var(--bg-subtle) 76%, var(--line) 24%)",
                borderColor: "color-mix(in srgb, var(--line) 82%, transparent)",
              }}
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: `${progress}%`,
                  background: `linear-gradient(90deg, ${meta.color}, ${meta.color}cc)`,
                }}
              />
            </div>
          </div>

          <div className="grid gap-2 text-xs sm:grid-cols-2">
            {assignee && (
              <div className="rounded-lg border px-3 py-2">
                <div className="text-[11px] text-muted-foreground">执行人</div>
                <div className="mt-1 font-medium">{assignee.role_title || assignee.id}</div>
              </div>
            )}
            {delegatedBy && (
              <div className="rounded-lg border px-3 py-2">
                <div className="text-[11px] text-muted-foreground">委派者</div>
                <div className="mt-1 font-medium">{delegatedBy.role_title || delegatedBy.id}</div>
              </div>
            )}
            {(runtime.runtime_phase || currentOwner || waitingNodes.length > 0 || runtime.last_error) && (
              <>
                {runtime.runtime_phase && (
                  <div className="rounded-lg border px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">运行阶段</div>
                    <div className="mt-1 font-medium">{RUNTIME_PHASE_LABEL[runtime.runtime_phase] || runtime.runtime_phase}</div>
                  </div>
                )}
                {(currentOwner || runtime.current_owner_node_id) && (
                  <div className="rounded-lg border px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">当前执行节点</div>
                    <div className="mt-1 font-medium">
                      {currentOwner ? (currentOwner.role_title || currentOwner.id) : runtime.current_owner_node_id}
                    </div>
                  </div>
                )}
                {waitingNodes.length > 0 && (
                  <div className="rounded-lg border px-3 py-2 sm:col-span-2">
                    <div className="text-[11px] text-muted-foreground">当前等待</div>
                    <div className="mt-1 font-medium">
                      {waitingNodes.map((id) => nodeMap.get(id)?.role_title || id).join("、")}
                    </div>
                  </div>
                )}
                {runtime.last_error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive sm:col-span-2">
                    <div className="text-[11px] opacity-80">最近异常</div>
                    <div className="mt-1 font-medium whitespace-pre-wrap">{runtime.last_error}</div>
                  </div>
                )}
              </>
            )}
            <div className="rounded-lg border px-3 py-2 sm:col-span-2">
              <div className="text-[11px] text-muted-foreground">创建时间</div>
              <div className="mt-1 font-medium">{fmt(task.created_at)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {(childChains.length > 0 || recentMessages.length > 0 || communicationRoutes.length > 0) && (
        <Card className="gap-0 py-0">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-base">协作观察</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 py-4">
            {childChains.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] text-muted-foreground">
                  子链状态：待完成 {collaboration.pending_children ?? 0} / 已完成 {collaboration.completed_children ?? 0} / 异常 {collaboration.failed_children ?? 0}
                </div>
                <div className="space-y-2">
                  {childChains.map((chain: any) => {
                    const node = chain.node_id ? nodeMap.get(chain.node_id) : null;
                    return (
                      <div key={chain.chain_id || `${chain.node_id}-${chain.status}`} className="rounded-lg border px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">{node ? (node.role_title || node.id) : (chain.node_id || "未知节点")}</div>
                          <Badge variant="outline" className="text-[10px]">
                            {RUNTIME_PHASE_LABEL[chain.status] || chain.status}
                          </Badge>
                        </div>
                        {chain.partial_result && (
                          <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap">{String(chain.partial_result)}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {communicationRoutes.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] text-muted-foreground">
                  通信链路：待回复 {communicationSummary.pending_replies ?? 0} / 已形成回复 {communicationSummary.replied_messages ?? 0}
                </div>
                <div className="space-y-2">
                  {communicationRoutes.map((route: any, idx: number) => {
                    const fromLabel = nodeMap.get(route.from_node)?.role_title || route.from_node || "未知";
                    const toLabel = nodeMap.get(route.to_node)?.role_title || route.to_node || "未知";
                    const routeStatusLabel =
                      route.status === "waiting_reply"
                        ? "待回复"
                        : route.status === "replied"
                          ? "已回复"
                          : "通信中";
                    return (
                      <div key={`${route.from_node}-${route.to_node}-${idx}`} className="rounded-lg border px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">{fromLabel} → {toLabel}</div>
                          <Badge variant="outline" className="text-[10px]">
                            {routeStatusLabel}
                          </Badge>
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {route.message_count || 0} 条消息
                          {route.last_message_type ? ` · ${route.last_message_type}` : ""}
                        </div>
                        {route.last_message_preview && (
                          <div className="mt-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap break-words">
                            {String(route.last_message_preview)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {recentMessages.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] text-muted-foreground">最近通信</div>
                <div className="space-y-2">
                  {recentMessages.map((msg: any, idx: number) => {
                    const fromLabel = nodeMap.get(msg.from_node)?.role_title || msg.from_node || "未知";
                    const toLabel = nodeMap.get(msg.to_node)?.role_title || msg.to_node || "未知";
                    return (
                      <div key={msg.id || idx} className="rounded-lg border px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">{fromLabel} → {toLabel}</div>
                          <div className="text-[11px] text-muted-foreground">{fmt(msg.created_at || msg.timestamp)}</div>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{msg.msg_type || "message"}</span>
                          {msg.awaiting_reply && <Badge variant="outline" className="text-[10px]">待回复</Badge>}
                          {msg.response_latency_s != null && (
                            <Badge variant="outline" className="text-[10px]">响应 {msg.response_latency_s}s</Badge>
                          )}
                        </div>
                        {msg.content && (
                          <div className="mt-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap break-words">
                            {String(msg.content)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {(task.plan_steps?.length ?? 0) > 0 && (
        <Card className="gap-0 py-0">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-base">计划步骤</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4 py-4">
            {(task.plan_steps || []).map((s: any, i: number) => {
              const st = s.status || "pending";
              const label = st === "completed" ? "已完成" : st === "in_progress" ? "进行中" : "待处理";
              const c = st === "completed" ? "#22c55e" : st === "in_progress" ? "#3b82f6" : "#94a3b8";
              return (
                <div key={s.id || i} className="flex items-start gap-3 rounded-lg border px-3 py-2">
                  <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c }} />
                  <div className="min-w-0 flex-1 text-sm leading-5">{s.description || s.title || `步骤 ${i + 1}`}</div>
                  <Badge variant="outline" className="text-[10px]" style={{ color: c }}>
                    {label}
                  </Badge>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {(task.subtasks?.length ?? 0) > 0 && (
        <Card className="gap-0 py-0">
          <CardHeader className="px-4 pt-4 pb-0">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">子任务</CardTitle>
              <Button variant="ghost" size="xs" className="text-xs text-muted-foreground" onClick={() => setSubtasksExpanded(!subtasksExpanded)}>
                {subtasksExpanded ? "收起" : "展开"} {task.subtasks.length}
              </Button>
            </div>
          </CardHeader>
          {subtasksExpanded && (
            <CardContent className="space-y-2 px-4 py-4">
              {(task.subtasks || []).map((st: any) => {
                const sm = STATUS_META[st.status] || { label: st.status, color: "#64748b" };
                const subProgress = Math.min(100, Math.max(0, st.progress_pct ?? 0));
                return (
                  <div key={st.id} className="space-y-2 rounded-lg border px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 text-sm font-medium">{st.title}</div>
                      <Badge variant="secondary" style={{ background: sm.color + "18", color: sm.color }}>
                        {sm.label}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>进度</span>
                      <span>{subProgress}%</span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full border"
                      style={{
                        background: "color-mix(in srgb, var(--bg-subtle) 76%, var(--line) 24%)",
                        borderColor: "color-mix(in srgb, var(--line) 82%, transparent)",
                      }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${subProgress}%`,
                          background: `linear-gradient(90deg, ${sm.color}, ${sm.color}cc)`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          )}
        </Card>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="px-4 pt-4 pb-0">
          <CardTitle className="text-base">执行时间线</CardTitle>
        </CardHeader>
        <CardContent className="px-4 py-4">
        {timeline.length === 0 ? (
          <div className="text-xs text-muted-foreground">暂无事件</div>
        ) : (
          <div className="flex max-h-[240px] flex-col gap-2 overflow-y-auto pr-1">
            {timeline.map((ev: any, i: number) => (
              <div key={i} className="rounded-lg border px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">{ev.event || "event"}</div>
                  <div className="text-[11px] text-muted-foreground">{ev.ts ? new Date(ev.ts).toLocaleString("zh-CN") : ""}</div>
                </div>
                {ev.actor && <div className="mt-1 text-[11px] text-muted-foreground">by {ev.actor}</div>}
                {ev.detail && <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{String(ev.detail)}</div>}
              </div>
            ))}
          </div>
        )}
        </CardContent>
      </Card>
    </div>
  );
}
