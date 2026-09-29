<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { relationLabel, relationOf, statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentGroup, DifferenceStatus, PendingRecord, TextUnit } from './types';

const {
  versions,
  leftVersionId,
  rightVersionId,
  rows,
  pending,
  rules,
  selectedGroupId,
  selectedRowIds,
  processing,
  progress,
  message,
  canUndo,
  canRedo,
  leftUnitMap,
  rightUnitMap,
  allUnitMap,
  selectedGroup,
  differenceCount,
  acceptedCount,
  unresolvedCount,
  pendingCount,
  runAlignment,
  recalculate,
  updateGroup,
  mergeGroups,
  splitGroup,
  moveRow,
  acceptRows,
  acceptAll,
  nextDifference,
  assignPending,
  dismissPending,
  addVersion,
  undo,
  redo,
  exportMarkdown,
  exportJson
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);
const assignTargets = ref<Record<string, string>>({});

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 132, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 320 },
  { title: '分组操作', dataIndex: 'align', slotName: 'align', width: 104, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 320 },
  { title: '校记 / 来源', dataIndex: 'note', slotName: 'note', width: 240 }
];

function unitsOf(group: AlignmentGroup, side: 'left' | 'right'): TextUnit[] {
  const map = side === 'left' ? leftUnitMap.value : rightUnitMap.value;
  const ids = side === 'left' ? group.leftIds : group.rightIds;
  return ids.map((id) => map.get(id)).filter((unit): unit is TextUnit => Boolean(unit));
}

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    if (!query) return true;
    const texts = [...unitsOf(row, 'left'), ...unitsOf(row, 'right')].map((unit) => unit.text);
    return [...texts, row.note, row.source, statusLabel(row.status), relationLabel(relationOf(row))]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query));
  });
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

const groupOptions = computed(() =>
  rows.value.map((group, index) => {
    const preview =
      unitsOf(group, 'left')[0]?.text ?? unitsOf(group, 'right')[0]?.text ?? '（空组）';
    return {
      value: group.id,
      label: `#${index + 1} ${relationLabel(relationOf(group))}｜${preview.slice(0, 14)}`
    };
  })
);

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

function mergeSelected() {
  if (mergeGroups(selectedRowIds.value.map(String))) {
    Message.success('已合并选中分组');
  } else {
    Message.warning('只能合并相邻的分组');
  }
}

function mergeWithNext(id: string) {
  const index = rows.value.findIndex((group) => group.id === id);
  if (index < 0 || index + 1 >= rows.value.length) {
    Message.info('已经是最后一组，没有可合并的下一组');
    return;
  }
  mergeGroups([id, rows.value[index + 1].id]);
}

function pendingPreview(record: PendingRecord, side: 'left' | 'right') {
  const ids = side === 'left' ? record.leftIds : record.rightIds;
  const texts = ids.map((id) => allUnitMap.value.get(id)?.text).filter(Boolean);
  return texts.length ? texts.join(' / ') : '（原句段已不存在）';
}

function confirmAssign(record: PendingRecord) {
  const target = assignTargets.value[record.id];
  if (!target) {
    Message.warning('请先选择归属分组');
    return;
  }
  assignPending(record.id, target);
  delete assignTargets.value[record.id];
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
    acceptRows(selectedRowIds.value.map(String));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0 || pendingCount.value > 0) {
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
          <div class="brand-subtitle">多对多分组对齐、人工修正、校记导出，全程本地保存</div>
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
            规则只影响相同/改动判断，原始正文始终保留；人工分组在重算时优先保留，引用失效句段的组会整体进入待归属区。
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
              <div class="stat-number" style="color: #722ed1">{{ pendingCount }}</div>
              <div class="stat-label">待归属</div>
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
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记或来源" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 组</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 组已勾选</a-tag>
            <a-button v-if="selectedRowIds.length >= 2" size="small" @click="mergeSelected">合并选中行</a-button>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="acceptRows(selectedRowIds.map(String))"
            >
              接受勾选建议
            </a-button>
          </div>
        </a-card>

        <a-card v-if="pending.length" :bordered="false" class="pending-card" style="margin-bottom: 12px">
          <template #title>
            <span style="color: #722ed1">待归属区（{{ pending.length }}）</span>
          </template>
          <template #extra>
            <span style="color: #86909c; font-size: 12px">旧校记找不到唯一归属，请人工指定</span>
          </template>
          <div v-for="record in pending" :key="record.id" class="pending-item">
            <div class="pending-texts">
              <div class="pending-line"><a-tag size="small">底本</a-tag>{{ pendingPreview(record, 'left') }}</div>
              <div class="pending-line"><a-tag size="small" color="arcoblue">参校</a-tag>{{ pendingPreview(record, 'right') }}</div>
              <div class="pending-meta">
                <span v-if="record.note">校记：{{ record.note }}</span>
                <span v-if="record.source">来源：{{ record.source }}</span>
                <a-tag v-if="record.accepted" size="small" color="green">原已接受</a-tag>
                <span style="color: #86909c">{{ record.reason }}</span>
              </div>
            </div>
            <div class="pending-actions">
              <a-select
                v-model="assignTargets[record.id]"
                placeholder="选择归属分组"
                style="width: 240px"
                :options="groupOptions"
                allow-search
              />
              <a-button size="small" type="primary" @click="confirmAssign(record)">指定归属</a-button>
              <a-button size="small" status="danger" @click="dismissPending(record.id)">删除</a-button>
            </div>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount || pendingCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 组差异尚未接受</span>
            <span v-if="pendingCount"> · {{ pendingCount }} 条记录待归属</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1160, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px">
                <a-tag size="small" color="purple">{{ relationLabel(relationOf(record)) }}</a-tag>
              </div>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manual" style="margin-top: 4px; color: #165dff; font-size: 11px">人工分组</div>
            </template>

            <template #left="{ record }">
              <template v-if="record.leftIds.length">
                <div v-for="(unit, k) in unitsOf(record, 'left')" :key="unit.id" class="unit-block">
                  <div class="paragraph-label">
                    段 {{ unit.paragraphOrder }} · 句 {{ unit.sentenceOrder }}
                    <span v-if="record.leftIds.length > 1">（{{ k + 1 }}/{{ record.leftIds.length }}）</span>
                  </div>
                  <div
                    class="diff-text"
                    :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'"
                  >
                    {{ unit.text }}
                  </div>
                </div>
              </template>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-tooltip content="与下一组合并为一个多对多分组">
                  <a-button size="mini" @click.stop="mergeWithNext(record.id)">并入下行</a-button>
                </a-tooltip>
                <a-button
                  size="mini"
                  :disabled="record.leftIds.length <= 1 && record.rightIds.length <= 1"
                  @click.stop="splitGroup(record.id)"
                >
                  拆回单句
                </a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">下移</a-button>
                <a-tooltip content="接受这一组的自动判断">
                  <a-button size="mini" status="success" @click.stop="acceptRows([record.id])">接受</a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <template v-if="record.rightIds.length">
                <div v-for="(unit, k) in unitsOf(record, 'right')" :key="unit.id" class="unit-block">
                  <div class="paragraph-label">
                    段 {{ unit.paragraphOrder }} · 句 {{ unit.sentenceOrder }}
                    <span v-if="record.rightIds.length > 1">（{{ k + 1 }}/{{ record.rightIds.length }}）</span>
                  </div>
                  <div
                    class="diff-text"
                    :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'"
                  >
                    {{ unit.text }}
                  </div>
                </div>
              </template>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
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
              <a-empty description="没有符合条件的对齐分组" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedGroup" color="arcoblue" style="margin-left: auto">
              {{ statusLabel(selectedGroup.status) }}
            </a-tag>
          </div>
        </section>

        <template v-if="selectedGroup">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">对齐关系</div>
            <a-tag color="purple">{{ relationLabel(relationOf(selectedGroup)) }}</a-tag>
            <span style="margin-left: 8px; color: #86909c; font-size: 12px">
              底本 {{ selectedGroup.leftIds.length }} 句 · 参校本 {{ selectedGroup.rightIds.length }} 句
            </span>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
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
            <div v-for="unit in unitsOf(selectedGroup, 'left')" :key="`l-${unit.id}`" class="diff-text same" style="margin-bottom: 6px">
              {{ unit.text }}
            </div>
            <div v-if="!selectedGroup.leftIds.length" class="diff-text same">（无）</div>
            <div style="height: 8px" />
            <div v-for="unit in unitsOf(selectedGroup, 'right')" :key="`r-${unit.id}`" class="diff-text changed" style="margin-bottom: 6px">
              {{ unit.text }}
            </div>
            <div v-if="!selectedGroup.rightIds.length" class="diff-text changed">（无）</div>
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
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">分组调整</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="mergeWithNext(selectedGroup.id)">并入下一行</a-button>
              <a-button
                :disabled="selectedGroup.leftIds.length <= 1 && selectedGroup.rightIds.length <= 1"
                @click="splitGroup(selectedGroup.id)"
              >
                拆回单句
              </a-button>
              <a-button @click="moveRow(selectedGroup.id, -1)">整组上移</a-button>
              <a-button @click="moveRow(selectedGroup.id, 1)">整组下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              合并只把相邻分组并为一组，不会改写底本或参校本原文；拆回单句后原校记进入待归属区。
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
            <p>选择中间表格的一组<br />即可合并拆分并填写校勘说明</p>
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
