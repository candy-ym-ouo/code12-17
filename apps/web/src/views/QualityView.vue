<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage, ElMessageBox } from "element-plus";
import { qualityApi, type QualityActionRecord, type QualityFinding } from "@/api";
import { apiErrorMessage } from "@/api/client";
import { speciesApi } from "@/api";
import EmptyState from "@/components/EmptyState.vue";
import type { Phenophase, Species } from "@/types/models";

const loading = ref(false);
const scanning = ref(false);
const findings = ref<QualityFinding[]>([]);
const counts = reactive({ OPEN: 0, RESOLVED: 0, DISMISSED: 0 });
const severityCounts = reactive({ CRITICAL: 0, WARNING: 0, INFO: 0 });

const filters = reactive({
  status: "OPEN" as "OPEN" | "RESOLVED" | "DISMISSED" | "ALL",
  category: "" as "" | "DATE" | "PHASE" | "FILE",
  severity: "" as "" | "CRITICAL" | "WARNING" | "INFO",
});

const scanForm = reactive({
  includeOrphanFiles: false,
  minYear: 1990,
  maxYear: dayjs().year() + 1,
  showAdvanced: false,
});

// 详情抽屉
const detailVisible = ref(false);
const detailLoading = ref(false);
const current = ref<(QualityFinding & { actions: QualityActionRecord[] }) | null>(null);

// 处置表单
const fixDate = ref(dayjs().format("YYYY-MM-DD"));
const phaseSpecies = ref<Species | null>(null);
const phaseSpeciesOptions = ref<Species[]>([]);
const selectedPhase = ref<string>("");

const phaseOptions = computed<Phenophase[]>(() => phaseSpecies.value?.phenophases ?? []);
const actionRunning = ref(false);

const severityTagType: Record<string, "danger" | "warning" | "info"> = {
  CRITICAL: "danger",
  WARNING: "warning",
  INFO: "info",
};
const statusTagType: Record<string, "success" | "info" | "warning"> = {
  OPEN: "warning",
  RESOLVED: "success",
  DISMISSED: "info",
};
const categoryLabel: Record<string, string> = { DATE: "日期越界", PHASE: "阶段缺失", FILE: "孤立文件" };
const actionLabel: Record<string, string> = {
  FIX_DATE: "修正日期",
  SYNC_OBSERVED_AT: "同步时间戳",
  SET_PHENOPHASE: "补齐物候阶段",
  QUARANTINE_FILE: "隔离孤立文件",
  DROP_PHOTO_ROW: "删除坏照片引用",
  DISMISS: "确认忽略",
};

const hasOpen = computed(() => counts.OPEN > 0);

async function load() {
  loading.value = true;
  try {
    const result = await qualityApi.listFindings({
      status: filters.status,
      category: filters.category || undefined,
      severity: filters.severity || undefined,
      limit: 200,
    });
    findings.value = result.items;
    counts.OPEN = result.meta.statusCounts.OPEN ?? 0;
    counts.RESOLVED = result.meta.statusCounts.RESOLVED ?? 0;
    counts.DISMISSED = result.meta.statusCounts.DISMISSED ?? 0;
    severityCounts.CRITICAL = result.meta.severityCounts.CRITICAL ?? 0;
    severityCounts.WARNING = result.meta.severityCounts.WARNING ?? 0;
    severityCounts.INFO = result.meta.severityCounts.INFO ?? 0;
  } catch (error) {
    ElMessage.error(apiErrorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function runScan() {
  scanning.value = true;
  try {
    const result = await qualityApi.scan({
      includeOrphanFiles: scanForm.includeOrphanFiles || undefined,
      ...(scanForm.showAdvanced
        ? { minYear: scanForm.minYear, maxYear: scanForm.maxYear }
        : {}),
    });
    const s = result.summary as {
      total: number;
      bySeverity: { CRITICAL: number; WARNING: number; INFO: number };
      byCategory: { DATE: number; PHASE: number; FILE: number };
    };
    ElMessageBox.alert(
      `共发现 ${s.total} 条问题：严重 ${s.bySeverity.CRITICAL}、警告 ${s.bySeverity.WARNING}、提示 ${s.bySeverity.INFO}。` +
        `日期类 ${s.byCategory.DATE}、阶段类 ${s.byCategory.PHASE}、文件类 ${s.byCategory.FILE}。`,
      "体检完成",
      { confirmButtonText: "知道了" },
    ).catch(() => undefined);
    await load();
  } catch (error) {
    ElMessage.error(apiErrorMessage(error));
  } finally {
    scanning.value = false;
  }
}

async function recompute() {
  try {
    const result = await qualityApi.recompute();
    ElMessage.success(`分级复算完成，${result.recomputed} 条问题的分级/建议发生变化`);
    await load();
  } catch (error) {
    ElMessage.error(apiErrorMessage(error));
  }
}

async function openDetail(row: QualityFinding) {
  detailVisible.value = true;
  detailLoading.value = true;
  current.value = null;
  try {
    current.value = await qualityApi.getFinding(row.id);
    if (current.value.suggestedAction === "SET_PHENOPHASE") {
      const species = await speciesApi.list({ includePreset: false });
      phaseSpeciesOptions.value = species.mine;
    }
  } catch (error) {
    ElMessage.error(apiErrorMessage(error));
  } finally {
    detailLoading.value = false;
  }
}

async function onSpeciesChange() {
  selectedPhase.value = "";
}

async function applyAction(action: string, confirmText?: string) {
  if (!current.value) return;
  if (confirmText) {
    try {
      await ElMessageBox.confirm(confirmText, "处置确认", { type: "warning" });
    } catch {
      return;
    }
  }
  actionRunning.value = true;
  try {
    const payload: { action: string; newDate?: string; phenophaseId?: string; speciesId?: string } = { action };
    if (action === "FIX_DATE") payload.newDate = fixDate.value;
    if (action === "SET_PHENOPHASE") {
      if (!selectedPhase.value) throw new Error("请选择物候阶段");
      payload.phenophaseId = selectedPhase.value;
      if (phaseSpecies.value) payload.speciesId = phaseSpecies.value.id;
    }
    await qualityApi.applyAction(current.value.id, payload);
    ElMessage.success("处置完成，凭据已留存，可在动作记录中回滚");
    await load();
    current.value = await qualityApi.getFinding(current.value.id);
  } catch (error) {
    ElMessage.error(apiErrorMessage(error));
  } finally {
    actionRunning.value = false;
  }
}

async function rollbackActionRecord(record: QualityActionRecord) {
  try {
    await ElMessageBox.confirm("凭该动作的改前快照回滚，确定继续？", "回滚确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await qualityApi.rollback(record.id);
    ElMessage.success("已回滚，凭据已标记为 ROLLED_BACK");
    await load();
    if (current.value) current.value = await qualityApi.getFinding(current.value.id);
  } catch (error) {
    ElMessage.error(apiErrorMessage(error));
  }
}

function formatTime(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

onMounted(load);
</script>

<template>
  <div class="quality-page">
    <div class="quality-header">
      <div>
        <h2>数据质量体检</h2>
        <p class="quality-subtitle">
          扫描历史坏数据中的日期越界、物候阶段缺失与孤立文件；分级由固定规则集计算、可随时复算，所有处置动作保留改前凭据、支持一键回滚。
        </p>
      </div>
      <div class="quality-header__actions">
        <el-button @click="recompute">复算分级</el-button>
        <el-button type="primary" :loading="scanning" @click="runScan">开始体检</el-button>
      </div>
    </div>

    <el-card class="scan-card" shadow="never">
      <el-form label-position="left" label-width="auto" inline>
        <el-form-item label="扫描孤立磁盘文件">
          <el-switch v-model="scanForm.includeOrphanFiles" />
          <span class="hint">需要管理员权限（普通用户可由服务器 CLI 扫描）</span>
        </el-form-item>
        <el-form-item>
          <el-button link type="primary" @click="scanForm.showAdvanced = !scanForm.showAdvanced">
            {{ scanForm.showAdvanced ? "收起高级选项" : "高级选项：合理年份窗口" }}
          </el-button>
        </el-form-item>
        <template v-if="scanForm.showAdvanced">
          <el-form-item label="最早年份">
            <el-input-number v-model="scanForm.minYear" :min="1900" :max="2200" />
          </el-form-item>
          <el-form-item label="最晚年份">
            <el-input-number v-model="scanForm.maxYear" :min="1900" :max="2200" />
          </el-form-item>
        </template>
      </el-form>
    </el-card>

    <div class="stat-row">
      <el-statistic title="待处理" :value="counts.OPEN" />
      <el-statistic title="严重" :value="severityCounts.CRITICAL" />
      <el-statistic title="警告" :value="severityCounts.WARNING" />
      <el-statistic title="提示" :value="severityCounts.INFO" />
      <el-statistic title="已消解" :value="counts.RESOLVED" />
      <el-statistic title="已忽略" :value="counts.DISMISSED" />
    </div>

    <div class="filter-row">
      <el-radio-group v-model="filters.status" @change="load">
        <el-radio-button value="OPEN">待处理</el-radio-button>
        <el-radio-button value="RESOLVED">已消解</el-radio-button>
        <el-radio-button value="DISMISSED">已忽略</el-radio-button>
        <el-radio-button value="ALL">全部</el-radio-button>
      </el-radio-group>
      <el-select v-model="filters.category" placeholder="全部分类" clearable style="width: 140px" @change="load">
        <el-option label="日期越界" value="DATE" />
        <el-option label="阶段缺失" value="PHASE" />
        <el-option label="孤立文件" value="FILE" />
      </el-select>
      <el-select v-model="filters.severity" placeholder="全部级别" clearable style="width: 140px" @change="load">
        <el-option label="严重" value="CRITICAL" />
        <el-option label="警告" value="WARNING" />
        <el-option label="提示" value="INFO" />
      </el-select>
    </div>

    <el-table v-loading="loading" :data="findings" empty-text=" ">
      <el-table-column label="级别" width="80">
        <template #default="{ row }">
          <el-tag :type="severityTagType[row.severity]" size="small">
            {{ row.severity === "CRITICAL" ? "严重" : row.severity === "WARNING" ? "警告" : "提示" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="分类" width="100">
        <template #default="{ row }">{{ categoryLabel[row.category] }}</template>
      </el-table-column>
      <el-table-column prop="title" label="问题" min-width="220" show-overflow-tooltip />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusTagType[row.status]" size="small" effect="plain">
            {{ row.status === "OPEN" ? "待处理" : row.status === "RESOLVED" ? "已消解" : "已忽略" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="建议动作" width="140">
        <template #default="{ row }">{{ actionLabel[row.suggestedAction] ?? row.suggestedAction }}</template>
      </el-table-column>
      <el-table-column label="最近出现" width="150">
        <template #default="{ row }">{{ formatTime(row.lastSeenAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情/处置</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState v-if="!loading" :title="hasOpen ? '当前筛选下没有问题' : '暂无待处理问题，数据很干净'" description="可以点击右上角「开始体检」重新扫描历史数据" />
      </template>
    </el-table>

    <el-drawer v-model="detailVisible" title="问题详情与处置" size="520px">
      <div v-loading="detailLoading">
        <template v-if="current">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="级别">
              <el-tag :type="severityTagType[current.severity]" size="small">{{ current.severity }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="规则编号">{{ current.ruleCode }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ current.status }}</el-descriptions-item>
            <el-descriptions-item label="说明">{{ current.detail }}</el-descriptions-item>
            <el-descriptions-item label="建议">{{ current.suggestion }}</el-descriptions-item>
            <el-descriptions-item label="证据">
              <pre class="evidence">{{ JSON.stringify(current.evidence, null, 2) }}</pre>
            </el-descriptions-item>
          </el-descriptions>

          <div v-if="current.status === 'OPEN'" class="action-panel">
            <h4>处置动作（执行前自动留存改前凭据）</h4>

            <template v-if="current.suggestedAction === 'FIX_DATE' || current.ruleCode === 'DATE_INVALID' || current.ruleCode === 'DATE_OUT_OF_RANGE'">
              <el-date-picker v-model="fixDate" type="date" value-format="YYYY-MM-DD" placeholder="选择正确日期" style="width: 100%" />
              <el-button type="primary" :loading="actionRunning" style="margin-top: 8px" @click="applyAction('FIX_DATE')">
                修正为该日期
              </el-button>
            </template>

            <template v-else-if="current.ruleCode === 'DATE_OBSERVED_AT_MISMATCH'">
              <el-button type="primary" :loading="actionRunning" @click="applyAction('SYNC_OBSERVED_AT')">
                把 observedAt 同步为日历日零点
              </el-button>
            </template>

            <template v-else-if="current.suggestedAction === 'SET_PHENOPHASE'">
              <el-select
                v-model="phaseSpecies"
                placeholder="选择物种"
                filterable
                style="width: 100%"
                @change="onSpeciesChange"
              >
                <el-option
                  v-for="speciesItem in phaseSpeciesOptions"
                  :key="speciesItem.id"
                  :label="speciesItem.commonName"
                  :value="speciesItem"
                />
              </el-select>
              <el-select
                v-model="selectedPhase"
                placeholder="选择物候阶段"
                style="width: 100%; margin-top: 8px"
                :disabled="!phaseSpecies"
              >
                <el-option v-for="phase in phaseOptions" :key="phase.id" :label="phase.name" :value="phase.id" />
              </el-select>
              <el-button
                type="primary"
                :loading="actionRunning"
                style="margin-top: 8px"
                @click="applyAction('SET_PHENOPHASE')"
              >
                补齐阶段
              </el-button>
            </template>

            <template v-else-if="current.suggestedAction === 'QUARANTINE_FILE'">
              <el-button
                type="warning"
                :loading="actionRunning"
                @click="applyAction('QUARANTINE_FILE', '将把该文件的现存变体移入隔离区（不硬删除），可凭凭据还原。继续？')"
              >
                隔离孤立文件
              </el-button>
            </template>

            <template v-else-if="current.suggestedAction === 'DROP_PHOTO_ROW'">
              <el-button
                type="danger"
                :loading="actionRunning"
                @click="applyAction('DROP_PHOTO_ROW', '物理文件已丢失，将删除照片元数据行（整行快照会写入凭据，可回滚重新插入）。继续？')"
              >
                删除坏照片引用
              </el-button>
            </template>

            <el-button :loading="actionRunning" style="margin-left: 8px" @click="applyAction('DISMISS')">
              确认忽略
            </el-button>
          </div>

          <div class="action-history">
            <h4>动作与回滚凭据（{{ current.actions.length }}）</h4>
            <el-timeline v-if="current.actions.length">
              <el-timeline-item
                v-for="record in current.actions"
                :key="record.id"
                :timestamp="formatTime(record.executedAt)"
                placement="top"
              >
                <div class="action-record">
                  <el-tag size="small" :type="record.rolledBackAt ? 'info' : 'success'">
                    {{ actionLabel[record.action] ?? record.action }}
                  </el-tag>
                  <el-tag v-if="record.rolledBackAt" size="small" type="info" style="margin-left: 6px">
                    已于 {{ formatTime(record.rolledBackAt) }} 回滚
                  </el-tag>
                  <el-button
                    v-if="!record.rolledBackAt && record.status !== 'VOIDED'"
                    link
                    type="warning"
                    size="small"
                    @click="rollbackActionRecord(record)"
                  >
                    回滚
                  </el-button>
                  <pre class="evidence small">{{ JSON.stringify({ params: record.params, before: record.beforeSnapshot, rollback: record.rollbackResult }, null, 2) }}</pre>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="还没有处置动作" :image-size="60" />
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.quality-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px 16px 60px;
}
.quality-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.quality-subtitle {
  color: var(--color-text-secondary, #666);
  font-size: 13px;
  max-width: 720px;
  margin: 6px 0 0;
}
.scan-card {
  margin: 16px 0;
}
.hint {
  margin-left: 10px;
  color: var(--color-text-secondary, #999);
  font-size: 12px;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.filter-row {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.evidence {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--color-fill-light, #f6f7f9);
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 220px;
  overflow: auto;
}
.evidence.small {
  max-height: 140px;
}
.action-panel,
.action-history {
  margin-top: 20px;
}
.action-panel h4,
.action-history h4 {
  margin: 0 0 10px;
}
.action-record {
  font-size: 13px;
}
@media (max-width: 720px) {
  .stat-row {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
