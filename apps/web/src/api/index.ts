import { http } from "./client";
import type {
  CompareResult,
  Observation,
  ObservationMeta,
  PhenologyResult,
  Phenophase,
  ShareLink,
  Site,
  Species,
  Tag,
  User,
} from "@/types/models";

export interface ApiList<T> {
  data: T[];
  meta?: Record<string, unknown>;
}

export const authApi = {
  async register(payload: { email: string; password: string; displayName: string }) {
    const { data } = await http.post<{ data: { accessToken: string; user: User } }>("/auth/register", payload);
    return data.data;
  },
  async login(payload: { email: string; password: string }) {
    const { data } = await http.post<{ data: { accessToken: string; user: User } }>("/auth/login", payload);
    return data.data;
  },
  async refresh() {
    const { data } = await http.post<{ data: { accessToken: string; user: User } }>("/auth/refresh", {});
    return data.data;
  },
  async logout() {
    await http.post("/auth/logout", {});
  },
  async me() {
    const { data } = await http.get<{ data: User }>("/auth/me");
    return data.data;
  },
  async updateMe(payload: Record<string, unknown>) {
    const { data } = await http.patch<{ data: User }>("/auth/me", payload);
    return data.data;
  },
};

export const siteApi = {
  async list(includeArchived = false) {
    const { data } = await http.get<ApiList<Site>>("/sites", { params: { includeArchived } });
    return data.data;
  },
  async create(payload: Record<string, unknown>) {
    const { data } = await http.post<{ data: Site }>("/sites", payload);
    return data.data;
  },
  async update(id: string, payload: Record<string, unknown>) {
    const { data } = await http.patch<{ data: Site }>(`/sites/${id}`, payload);
    return data.data;
  },
  async archive(id: string) {
    await http.post(`/sites/${id}/archive`, {});
  },
  async unarchive(id: string) {
    await http.post(`/sites/${id}/unarchive`, {});
  },
  async remove(id: string) {
    await http.delete(`/sites/${id}`);
  },
  async createShare(id: string, payload: { scope: string; expiresInDays: number }) {
    const { data } = await http.post<{ data: ShareLink }>(`/sites/${id}/share`, payload);
    return data.data;
  },
  async listShares(id: string) {
    const { data } = await http.get<ApiList<ShareLink>>(`/sites/${id}/share-links`);
    return data.data;
  },
  async revokeShare(linkId: string) {
    await http.delete(`/share-links/${linkId}`);
  },
};

export const speciesApi = {
  async list(params: { category?: string; q?: string; includePreset?: boolean } = {}) {
    const { data } = await http.get<{ data: { mine: Species[]; presets: Species[] } }>("/species", {
      params: { includePreset: params.includePreset ?? true, category: params.category, q: params.q },
    });
    return data.data;
  },
  async create(payload: Record<string, unknown>) {
    const { data } = await http.post<{ data: Species }>("/species", payload);
    return data.data;
  },
  async update(id: string, payload: Record<string, unknown>) {
    const { data } = await http.patch<{ data: Species }>(`/species/${id}`, payload);
    return data.data;
  },
  async importPreset(presetId: string) {
    const { data } = await http.post<{ data: Species }>("/species/import-preset", { presetId });
    return data.data;
  },
  async archive(id: string) {
    await http.post(`/species/${id}/archive`, {});
  },
  async remove(id: string) {
    await http.delete(`/species/${id}`);
  },
  async createPhenophase(speciesId: string, payload: Record<string, unknown>) {
    const { data } = await http.post<{ data: Phenophase }>(`/species/${speciesId}/phenophases`, payload);
    return data.data;
  },
  async deletePhenophase(phenophaseId: string) {
    await http.delete(`/phenophases/${phenophaseId}`);
  },
};

export const tagApi = {
  async list() {
    const { data } = await http.get<ApiList<Tag>>("/tags");
    return data.data;
  },
  async create(name: string, color: string) {
    const { data } = await http.post<{ data: Tag }>("/tags", { name, color });
    return data.data;
  },
  async remove(id: string) {
    await http.delete(`/tags/${id}`);
  },
};

export interface ObservationQuery {
  siteId?: string;
  speciesId?: string;
  phenophaseId?: string;
  kind?: string;
  status?: string;
  from?: string;
  to?: string;
  keyword?: string;
  hasPhotos?: boolean;
  sort?: "date_desc" | "date_asc";
  limit?: number;
  cursor?: string | null;
}

export const observationApi = {
  async list(query: ObservationQuery) {
    const { data } = await http.get<{ data: Observation[]; meta: ObservationMeta }>("/observations", {
      params: {
        ...query,
        hasPhotos: query.hasPhotos ? "true" : undefined,
        cursor: query.cursor ?? undefined,
      },
    });
    return { items: data.data, meta: data.meta };
  },
  async get(id: string) {
    const { data } = await http.get<{ data: Observation }>(`/observations/${id}`);
    return data.data;
  },
  async create(payload: Record<string, unknown>) {
    const { data } = await http.post<{ data: Observation }>("/observations", payload);
    return data.data;
  },
  async update(id: string, payload: Record<string, unknown>) {
    const { data } = await http.patch<{ data: Observation }>(`/observations/${id}`, payload);
    return data.data;
  },
  async remove(id: string) {
    await http.delete(`/observations/${id}`);
  },
  async publish(id: string) {
    const { data } = await http.post<{ data: Observation }>(`/observations/${id}/publish`, {});
    return data.data;
  },
  async uploadPhotos(id: string, files: File[]) {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const { data } = await http.post<{
      data: { succeeded: Array<{ id: string; originalName: string; thumbUrl: string }>; failed: Array<{ originalName: string; reason: string }> };
    }>(`/observations/${id}/photos`, form);
    return data.data;
  },
  async removePhoto(photoId: string) {
    await http.delete(`/photos/${photoId}`);
  },
};

export const statsApi = {
  async compare(params: { siteId: string; speciesId: string; phenophaseId?: string; years?: number[] }) {
    const { data } = await http.get<{ data: CompareResult }>("/stats/compare", {
      params: { ...params, years: params.years?.length ? params.years.join(",") : undefined },
    });
    return data.data;
  },
  async phenology(params: { siteId: string; speciesId: string; phenophaseId?: string }) {
    const { data } = await http.get<{ data: PhenologyResult }>("/stats/phenology", { params });
    return data.data;
  },
  async overview(params: { siteId?: string } = {}) {
    const { data } = await http.get<{ data: {
      total: number;
      published: number;
      drafts: number;
      speciesCount: number;
      firstObservationDate: string | null;
      lastObservationDate: string | null;
      byKind: Array<{ kind: string; count: number }>;
    } }>("/stats/overview", { params });
    return data.data;
  },
  async weather(params: { siteId: string; monthDay: string; windowDays?: number; year?: number }) {
    const { data } = await http.get<{ data: {
      baseline: { temperatureC: number | null; yearsUsed: number[]; insufficientBaseline: boolean };
      current: Array<{ id: string; observationDate: string; temperatureC: number | null; deviation: number | null; notes: string | null }>;
      history: Array<{ year: number; temperatureC: number | null }>;
    } }>("/stats/weather", { params });
    return data.data;
  },
};

export interface QualityFinding {
  id: string;
  reportId: string;
  ruleCode: string;
  category: "DATE" | "PHASE" | "FILE";
  severity: "CRITICAL" | "WARNING" | "INFO";
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  entityType: string;
  entityId: string | null;
  storageKey: string | null;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  suggestion: string;
  suggestedAction: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

export interface QualityActionRecord {
  id: string;
  findingId?: string;
  action: string;
  status: string;
  params: Record<string, unknown> | null;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown> | null;
  rollbackResult: Record<string, unknown> | null;
  executedAt: string;
  rolledBackAt: string | null;
}

export const qualityApi = {
  async scan(body: {
    minYear?: number;
    maxYear?: number;
    includeOrphanFiles?: boolean;
    categories?: Array<"DATE" | "PHASE" | "FILE">;
  } = {}) {
    const { data } = await http.post<{ data: { reportId: string; summary: Record<string, unknown>; params: Record<string, unknown> } }>(
      "/quality/scan",
      body,
    );
    return data.data;
  },
  async recompute() {
    const { data } = await http.post<{ data: { recomputed: number } }>("/quality/recompute", {});
    return data.data;
  },
  async listFindings(params: {
    status?: string;
    severity?: string;
    category?: string;
    ruleCode?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const { data } = await http.get<{ data: QualityFinding[]; meta: Record<string, unknown> }>("/quality/findings", { params });
    return { items: data.data, meta: data.meta as { statusCounts: Record<string, number>; severityCounts: Record<string, number>; total: number } };
  },
  async getFinding(id: string) {
    const { data } = await http.get<{ data: QualityFinding & { actions: QualityActionRecord[] } }>(`/quality/findings/${id}`);
    return data.data;
  },
  async applyAction(
    findingId: string,
    body: { action: string; newDate?: string; phenophaseId?: string; speciesId?: string; reason?: string },
  ) {
    const { data } = await http.post<{ data: Record<string, unknown> }>(`/quality/findings/${findingId}/actions`, body);
    return data.data;
  },
  async rollback(actionId: string) {
    const { data } = await http.post<{ data: Record<string, unknown> }>(`/quality/actions/${actionId}/rollback`, {});
    return data.data;
  },
  async listActions(params: { findingId?: string; limit?: number; offset?: number } = {}) {
    const { data } = await http.get<ApiList<QualityActionRecord>>("/quality/actions", { params });
    return data.data;
  },
  async listReports(params: { limit?: number; offset?: number } = {}) {
    const { data } = await http.get<ApiList<Record<string, unknown>>>("/quality/reports", { params });
    return data.data;
  },
};

export const shareApi = {
  async view(token: string) {
    const { data } = await http.get<{ data: {
      site: Site;
      owner: { displayName: string };
      scope: string;
      expiresAt: string;
      observations: Observation[];
    } }>(`/share/${token}`);
    return data.data;
  },
};

export function exportUrl(params: { format: "csv" | "json"; siteId?: string; from?: string; to?: string; kind?: string }) {
  const search = new URLSearchParams();
  search.set("format", params.format);
  if (params.siteId) search.set("siteId", params.siteId);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.kind) search.set("kind", params.kind);
  return `/api/v1/export/observations?${search.toString()}`;
}

export async function downloadExport(
  params: { format: "csv" | "json"; siteId?: string; from?: string; to?: string; kind?: string },
  filename: string,
): Promise<void> {
  const response = await http.get(exportUrl(params).replace("/api/v1", ""), { responseType: "blob" });
  const blobUrl = URL.createObjectURL(response.data as Blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(blobUrl);
}
