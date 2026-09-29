<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { relationLabel, statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentGroup, DifferenceStatus } from './types';

const {
  versions,
  leftVersionId,
  rightVersionId,
  groups,
  pending,
  rules,
  selectedGroupId,
  selectedRowIds,
  processing,
  progress,
  message,
  canUndo,
  canRedo,
  selectedGroup,
  differenceCount,
  acceptedCount,
  unresolvedCount,
  leftUnitsOf,
  rightUnitsOf,
  runAlignment,
  recalculate,
  updateGroup,
  mergeGroups,
  splitGroup,
  assignPending,
  discardPending,
  moveGroup,
  shiftPairing,
  acceptGroups,
  acceptAll,
  nextDifference,
  addVersion,
  undo,
  redo,
  exportMarkdown,
  exportJson,
  commit
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);
const pendingAssignments = ref<Record<string, string>>({});

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '关系', dataIndex: 'relation', slotName: 'relation', width: 96 },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 320 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 150, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 320 },
  { title: '校记 / 来源', dataIndex: 'note', slotName: 'note', width: 240 }
];

const filteredGroups = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return groups.value.filter((group) => {
    if (onlyDifferences.value && group.status === 'same') return false;
    if (!query) return true;
    const leftText = leftUnitsOf(group).map((unit) => unit.text).join(' ');
    const rightText = rightUnitsOf(group).map((unit) => unit.text).join(' ');
    return [leftText, rightText, group.note, group.source, statusLabel(group.status), relationLabel(group)]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
});

const groupOptions = computed(() =>
  groups.value.map((group, index) => {
    const leftText = leftUnitsOf(group)[0]?.text ?? '';
    const rightText = rightUnitsOf(group)[0]?.text ?? '';
    return {
      value: group.id,
      label: `第 ${index + 1} 组 · ${relationLabel(group)} · ${leftText || '（无）'} ║ ${rightText || '（无）'}`
    };
  })
);

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

watch(
  selectedGroup,
  (group) => {
    noteDraft.value = group?.note ?? '';
    sourceDraft.value = group?.source ?? '';
  },
  { immediate: true }
);

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function rowClass(record: AlignmentGroup) {
  return record.id === selectedGroupId.value ? 'row-active' : '';
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedGroup.value) return;
  updateGroup(selectedGroup.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const group = record as unknown as AlignmentGroup;
  selectedGroupId.value = group.id;
}

function saveAnnotation() {
  if (!selectedGroup.value) return;
  updateGroup(selectedGroup.value.id, {
    note: noteDraft.value.trim(),
    source: sourceDraft.value.trim()
  });
  Message.success('校勘说明已保存');
}

function handleMergeSelected() {
  if (selectedRowIds.value.length < 2) {
    Message.warning('请先勾选至少两个相邻的行');
    return;
  }
  mergeGroups(selectedRowIds.value.map(String));
}

function handleAssignPending(pendingId: string) {
  const target = pendingAssignments.value[pendingId];
  if (!target) {
    Message.warning('请先选择要指派到的句组');
    return;
  }
  assignPending(pendingId, target);
  delete pendingAssignments.value[pendingId];
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (kind === 'markdown') {
    download('校勘记.md', exportMarkdown(), 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', exportJson(), 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

function pendingUnitText(ids: string[], side: 'left' | 'right'): string {
  const versionId = side === 'left' ? leftVersionId.value : rightVersionId.value;
  const versionUnits = versions.value.find((item) => item.id === versionId)?.units ?? [];
  return ids
    .map((id) => versionUnits.find((unit) => unit.id === id)?.text)
    .filter(Boolean)
    .join(' ║ ');
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    acceptGroups(selectedRowIds.value.map(String));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">多对多分组、人工合并拆组、校记按句迁移，全程本地保存</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-dropdown>
            <a-button>导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select v-model="leftVersionId" aria-label="底本">
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select v-model="rightVersionId" aria-label="参校本">
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；重算保留人工分组，不会把组拆成一对一。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待校勘</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">已接受</div>
            </div>
            <div class="stat-card">
              <div class="stat-number">{{ groups.length }}</div>
              <div class="stat-label">对齐句组</div>
            </div>
          </div>
          <a-button long type="primary" status="success" style="margin-top: 12px" :disabled="!unresolvedCount" @click="acceptAll">
            批量接受全部建议
          </a-button>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未接受差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选建议</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card v-if="pending.length" :bordered="false" class="pending-card">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px">
            <a-tag color="orange">待归属</a-tag>
            <strong style="font-size: 13px">有 {{ pending.length }} 条校记找不到唯一归属，请到待归属区指定句组</strong>
          </div>
          <div v-for="item in pending" :key="item.id" class="pending-item">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
              <a-tag size="small" color="arcoblue">{{ statusLabel(item.status) }}</a-tag>
              <a-tag size="small" color="gray">{{ item.reason === 'units-missing' ? '句段缺失' : item.reason === 'invalid-group' ? '分组失效' : '跨组拆分' }}</a-tag>
              <span style="color: #86909c; font-size: 12px">{{ item.reasonText }}</span>
            </div>
            <div class="pending-units">
              <div v-if="item.leftUnitIds.length">
                <span class="pending-side">底本：</span>{{ pendingUnitText(item.leftUnitIds, 'left') || '（句段已不存在）' }}
              </div>
              <div v-if="item.rightUnitIds.length">
                <span class="pending-side">参校本：</span>{{ pendingUnitText(item.rightUnitIds, 'right') || '（句段已不存在）' }}
              </div>
            </div>
            <div v-if="item.note" class="pending-note">校记：{{ item.note }}</div>
            <div v-if="item.source" class="pending-note">来源：{{ item.source }}</div>
            <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap">
              <a-select
                v-model="pendingAssignments[item.id]"
                placeholder="选择要指派到的句组"
                size="small"
                style="min-width: 320px; max-width: 520px"
                :options="groupOptions"
              />
              <a-button size="small" type="primary" @click="handleAssignPending(item.id)">指派到该组</a-button>
              <a-button size="small" @click="discardPending(item.id)">丢弃</a-button>
            </div>
          </div>
        </a-card>

        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记或来源" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredGroups.length }} / {{ groups.length }} 组</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              size="small"
              style="margin-left: auto"
              @click="handleMergeSelected"
            >
              合并勾选行
            </a-button>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              @click="acceptGroups(selectedRowIds.map(String))"
            >
              接受勾选建议
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚未接受</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredGroups"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1240, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
            </template>

            <template #relation="{ record }">
              <a-tag size="small" color="purple">{{ relationLabel(record) }}</a-tag>
              <div v-if="record.manualGroup" style="margin-top: 4px; color: #165dff; font-size: 11px">人工分组</div>
            </template>

            <template #left="{ record }">
              <template v-if="record.leftUnitIds.length">
                <div v-for="unit in leftUnitsOf(record)" :key="unit.id" class="unit-block">
                  <div class="paragraph-label">段 {{ unit.paragraphOrder }} · 句 {{ unit.sentenceOrder }}</div>
                  <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                    {{ unit.text }}
                  </div>
                </div>
              </template>
              <div v-else class="empty-cell">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveGroup(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveGroup(record.id, 1)">整行下移</a-button>
                <a-button size="mini" @click.stop="splitGroup(record.id)">拆成单句</a-button>
                <a-tooltip content="接受这一组的自动判断">
                  <a-button size="mini" status="success" @click.stop="acceptGroups([record.id])">接受</a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <template v-if="record.rightUnitIds.length">
                <div v-for="unit in rightUnitsOf(record)" :key="unit.id" class="unit-block">
                  <div class="paragraph-label">段 {{ unit.paragraphOrder }} · 句 {{ unit.sentenceOrder }}</div>
                  <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                    {{ unit.text }}
                  </div>
                </div>
              </template>
              <div v-else class="empty-cell">无对应参校本句</div>
            </template>

            <template #note="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <div>{{ record.note || '尚未填写校勘说明' }}</div>
                <div v-if="record.source" style="margin-top: 5px; color: #86909c">来源：{{ record.source }}</div>
                <a-tag v-if="record.accepted" size="small" color="green" style="margin-top: 7px">已接受</a-tag>
                <a-tag v-else size="small" color="orange" style="margin-top: 7px">待处理</a-tag>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐句组" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedGroup" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedGroup.status) }}</a-tag>
          </div>
        </section>

        <template v-if="selectedGroup">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">关系与类别</div>
            <a-space wrap style="margin-bottom: 10px">
              <a-tag color="purple">{{ relationLabel(selectedGroup) }}</a-tag>
              <a-tag v-if="selectedGroup.manualGroup" color="arcoblue">人工分组</a-tag>
              <a-tag v-if="selectedGroup.manuallyAdjusted" color="arcoblue">人工调整</a-tag>
            </a-space>
            <a-select :model-value="selectedGroup.status" style="width: 100%" @change="updateStatus">
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div v-for="unit in leftUnitsOf(selectedGroup)" :key="'l-' + unit.id" class="unit-block">
              <div class="paragraph-label">段 {{ unit.paragraphOrder }} · 句 {{ unit.sentenceOrder }}</div>
              <div class="diff-text same">{{ unit.text }}</div>
            </div>
            <div v-if="!selectedGroup.leftUnitIds.length" class="diff-text same">（无）</div>
            <div style="height: 8px" />
            <div v-for="unit in rightUnitsOf(selectedGroup)" :key="'r-' + unit.id" class="unit-block">
              <div class="paragraph-label">段 {{ unit.paragraphOrder }} · 句 {{ unit.sentenceOrder }}</div>
              <div class="diff-text changed">{{ unit.text }}</div>
            </div>
            <div v-if="!selectedGroup.rightUnitIds.length" class="diff-text changed">（无）</div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">校勘说明</div>
            <a-textarea
              v-model="noteDraft"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 5, maxRows: 10 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源，如：某刻本、某整理者" style="margin-top: 10px" />
            <a-button long type="primary" style="margin-top: 10px" @click="saveAnnotation">保存校勘说明</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">分组与错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedGroup.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedGroup.id, 1)">配对向后</a-button>
              <a-button @click="moveGroup(selectedGroup.id, -1)">整行上移</a-button>
              <a-button @click="moveGroup(selectedGroup.id, 1)">整行下移</a-button>
              <a-button @click="splitGroup(selectedGroup.id)">拆成单句</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              合并请先在表格中勾选相邻行再点“合并勾选行”；拆组会把句组拆回单句，校记按句段标识迁移。
            </a-alert>
          </section>

          <section class="panel-section">
            <a-button
              long
              :status="selectedGroup.accepted ? 'normal' : 'success'"
              :type="selectedGroup.accepted ? 'outline' : 'primary'"
              @click="updateGroup(selectedGroup.id, { accepted: !selectedGroup.accepted })"
            >
              {{ selectedGroup.accepted ? '撤回接受状态' : '接受这条校勘建议' }}
            </a-button>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一个句组<br />即可调整分组并填写校勘说明</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据保存在当前浏览器，刷新后继续。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>
</template>
