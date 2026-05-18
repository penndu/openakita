/**
 * V2 organisation API client wrappers.
 *
 * Mirrors the v2 endpoints in ``src/openakita/api/routes/orgs_v2.py``
 * exposed by the backend behind ``settings.runtime_v2_enabled``. All
 * functions take ``apiBase`` (the result of ``httpApiBase()``) as the
 * first argument so they stay decoupled from any single React
 * component's state plumbing.
 *
 * Endpoints covered:
 *   GET    /api/v2/orgs/templates                      listTemplates
 *   GET    /api/v2/orgs/templates/{id}                  getTemplate
 *   POST   /api/v2/orgs/templates/{id}/instantiate      instantiateTemplate
 *   GET    /api/v2/orgs                                 listOrgs
 *   POST   /api/v2/orgs                                 createOrg
 *   GET    /api/v2/orgs/{id}                            getOrg
 *   PATCH  /api/v2/orgs/{id}                            patchOrg
 *   DELETE /api/v2/orgs/{id}                            deleteOrg
 *
 * The frontend uses these wrappers from a Template-picker drawer (the
 * Phase-6 entry point for v2 org creation) and, in Phase 7, from the
 * full org editor.
 */

import { apiGet, apiPost, apiPostRaw } from "../api";
import { apiUrl } from "../platform/apiUrl";
import { safeFetch } from "../providers";

// ---------------------------------------------------------------------------
// Wire types — kept loose on purpose. The backend ships ``to_jsonable``
// snapshots that may grow new optional fields without breaking older
// frontends.
// ---------------------------------------------------------------------------

export interface TemplateNodeWire {
  id: string;
  type: string;
  role: string;
  label: string;
  persona_prompt?: string | null;
  parent_id?: string | null;
  [key: string]: unknown;
}

export interface TemplateEdgeWire {
  id: string;
  org_id: string;
  src: string;
  dst: string;
  kind: string;
  [key: string]: unknown;
}

export interface TemplateWire {
  id: string;
  name: string;
  description?: string | null;
  nodes: TemplateNodeWire[];
  edges: TemplateEdgeWire[];
  [key: string]: unknown;
}

export interface OrgWire {
  id: string;
  name: string;
  template_id?: string | null;
  description?: string | null;
  status: string;
  nodes: TemplateNodeWire[];
  edges: TemplateEdgeWire[];
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ListTemplatesResponse {
  templates: TemplateWire[];
  count: number;
}

export interface ListOrgsResponse {
  orgs: OrgWire[];
  count: number;
}

export interface InstantiateBody {
  name: string;
  description?: string | null;
  defaults?: Record<string, unknown>;
  node_persona_prompts?: Record<string, string>;
  node_runtime_overrides?: Record<string, Record<string, unknown>>;
}

export interface PatchOrgBody {
  name?: string;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function listTemplates(apiBase: string): Promise<ListTemplatesResponse> {
  return apiGet<ListTemplatesResponse>(apiUrl(apiBase, "api", "v2", "orgs", "templates"));
}

export function getTemplate(apiBase: string, templateId: string): Promise<TemplateWire> {
  return apiGet<TemplateWire>(apiUrl(apiBase, "api", "v2", "orgs", "templates", templateId));
}

export function instantiateTemplate(
  apiBase: string,
  templateId: string,
  body: InstantiateBody,
): Promise<OrgWire> {
  return apiPost<OrgWire>(
    apiUrl(apiBase, "api", "v2", "orgs", "templates", templateId, "instantiate"),
    body,
  );
}

// ---------------------------------------------------------------------------
// Orgs CRUD
// ---------------------------------------------------------------------------

export function listOrgs(apiBase: string): Promise<ListOrgsResponse> {
  return apiGet<ListOrgsResponse>(apiUrl(apiBase, "api", "v2", "orgs"));
}

export function createOrg(apiBase: string, org: OrgWire): Promise<OrgWire> {
  return apiPost<OrgWire>(apiUrl(apiBase, "api", "v2", "orgs"), { org });
}

export function getOrg(apiBase: string, orgId: string): Promise<OrgWire> {
  return apiGet<OrgWire>(apiUrl(apiBase, "api", "v2", "orgs", orgId));
}

export async function patchOrg(
  apiBase: string,
  orgId: string,
  body: PatchOrgBody,
): Promise<OrgWire> {
  const res = await safeFetch(apiUrl(apiBase, "api", "v2", "orgs", orgId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<OrgWire>;
}

export async function deleteOrg(apiBase: string, orgId: string): Promise<void> {
  await safeFetch(apiUrl(apiBase, "api", "v2", "orgs", orgId), { method: "DELETE" });
}

// Re-export apiPostRaw so callers can opt into low-level error inspection
// (e.g. show 404 from the disabled-v2 case as a UI hint).
export { apiPostRaw };
