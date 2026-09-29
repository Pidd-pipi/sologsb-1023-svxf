import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentGroup,
  ComparisonRules,
  DifferenceStatus,
  PendingRecord,
  PersistedCollationState,
  RelationKind,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const LEGACY_STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(hasLeft: boolean, hasRight: boolean, ratio: number): DifferenceStatus {
  if (!hasLeft) return 'added';
  if (!hasRight) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

export function relationOf(group: Pick<AlignmentGroup, 'leftIds' | 'rightIds'>): RelationKind {
  const left = group.leftIds.length;
  const right = group.rightIds.length;
  if (!left) return 'right-only';
  if (!right) return 'left-only';
  if (left === 1 && right === 1) return 'one-to-one';
  if (left === 1) return 'one-to-many';
  if (right === 1) return 'many-to-one';
  return 'many-to-many';
}

export function relationLabel(kind: RelationKind) {
  return {
    'one-to-one': '一对一',
    'one-to-many': '一对多',
    'many-to-one': '多对一',
    'many-to-many': '多对多',
    'left-only': '仅底本',
    'right-only': '仅参校本'
  }[kind];
}

function combineText(units: TextUnit[]) {
  return units.map((unit) => unit.text).join('');
}

function groupScore(leftUnits: TextUnit[], rightUnits: TextUnit[], rules: ComparisonRules) {
  if (!leftUnits.length || !rightUnits.length) return 0;
  return Number(similarity(normalized(combineText(leftUnits), rules), normalized(combineText(rightUnits), rules)).toFixed(3));
}

let groupSequence = 0;

function makeGroup(leftUnits: TextUnit[], rightUnits: TextUnit[], rules: ComparisonRules, manual = false): AlignmentGroup {
  const score = groupScore(leftUnits, rightUnits, rules);
  groupSequence += 1;
  return {
    id: `grp-${Date.now().toString(36)}-${groupSequence}`,
    leftIds: leftUnits.map((unit) => unit.id),
    rightIds: rightUnits.map((unit) => unit.id),
    status: statusFor(leftUnits.length > 0, rightUnits.length > 0, score),
    similarity: score,
    note: '',
    source: '',
    accepted: score > 0.995,
    manual
  };
}

function refreshGroup(group: AlignmentGroup, leftUnits: TextUnit[], rightUnits: TextUnit[], rules: ComparisonRules) {
  const score = groupScore(leftUnits, rightUnits, rules);
  group.similarity = score;
  group.status = statusFor(leftUnits.length > 0, rightUnits.length > 0, score);
}

/** 有校勘内容（校记 / 来源 / 人工接受 / 人工分组）的记录才需要在重排后迁移归属 */
function hasContent(group: AlignmentGroup) {
  return Boolean(group.note || group.source || group.manual || (group.accepted && group.status !== 'same'));
}

function toPending(group: AlignmentGroup, reason: string): PendingRecord {
  return {
    id: `pend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    leftIds: [...group.leftIds],
    rightIds: [...group.rightIds],
    note: group.note,
    source: group.source,
    accepted: group.accepted,
    reason
  };
}

function mergeAnnotation(target: AlignmentGroup, note: string, source: string, accepted: boolean) {
  target.note = [target.note, note].filter(Boolean).join('；');
  target.source = [...new Set([target.source, source].filter(Boolean))].join('；');
  target.accepted = target.accepted || accepted;
}

interface AnchorSpan {
  group: AlignmentGroup;
  ls: number | null;
  le: number | null;
  rs: number | null;
  re: number | null;
}

/**
 * 把人工分组整理成对齐锚点：引用句段必须仍然存在、互不重叠且不与原文顺序冲突，
 * 不满足的人工分组整体进入待归属区，绝不拆成一对一。
 */
function buildAnchors(manualGroups: AlignmentGroup[], leftUnits: TextUnit[], rightUnits: TextUnit[]) {
  const leftIndex = new Map(leftUnits.map((unit, index) => [unit.id, index]));
  const rightIndex = new Map(rightUnits.map((unit, index) => [unit.id, index]));
  const spans: AnchorSpan[] = [];
  const invalid: { group: AlignmentGroup; reason: string }[] = [];
  const used = new Set<string>();

  for (const group of manualGroups) {
    const leftIdx = group.leftIds.map((id) => leftIndex.get(id));
    const rightIdx = group.rightIds.map((id) => rightIndex.get(id));
    const missing = leftIdx.some((idx) => idx == null) || rightIdx.some((idx) => idx == null);
    const empty = !group.leftIds.length && !group.rightIds.length;
    const duplicated =
      group.leftIds.some((id) => used.has(`L:${id}`)) || group.rightIds.some((id) => used.has(`R:${id}`));
    if (missing || empty) {
      invalid.push({ group, reason: '人工分组引用了不存在的句段' });
      continue;
    }
    if (duplicated) {
      invalid.push({ group, reason: '人工分组之间句段重叠' });
      continue;
    }
    group.leftIds.forEach((id) => used.add(`L:${id}`));
    group.rightIds.forEach((id) => used.add(`R:${id}`));
    spans.push({
      group,
      ls: leftIdx.length ? Math.min(...(leftIdx as number[])) : null,
      le: leftIdx.length ? Math.max(...(leftIdx as number[])) + 1 : null,
      rs: rightIdx.length ? Math.min(...(rightIdx as number[])) : null,
      re: rightIdx.length ? Math.max(...(rightIdx as number[])) + 1 : null
    });
  }

  spans.sort((a, b) => Math.min(a.ls ?? Infinity, a.rs ?? Infinity) - Math.min(b.ls ?? Infinity, b.rs ?? Infinity));
  const anchors: AnchorSpan[] = [];
  let leftEnd = 0;
  let rightEnd = 0;
  for (const span of spans) {
    const startsOk = (span.ls == null || span.ls >= leftEnd) && (span.rs == null || span.rs >= rightEnd);
    if (!startsOk) {
      invalid.push({ group: span.group, reason: '人工分组与原文顺序冲突' });
      continue;
    }
    anchors.push(span);
    leftEnd = Math.max(leftEnd, span.le ?? 0);
    rightEnd = Math.max(rightEnd, span.re ?? 0);
  }
  return { anchors, invalid };
}

/**
 * 分片贪心对齐：人工分组作为锚点原样保留，锚点之间自动配对；
 * 自动配对时会尝试把相邻句段合成一组（一句拆多句、多句并一句、多对多）。
 */
async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  anchors: AnchorSpan[],
  onProgress: (value: number) => void
): Promise<AlignmentGroup[]> {
  const groups: AlignmentGroup[] = [];
  const anchoredLeft = new Array<boolean>(leftUnits.length).fill(false);
  const anchoredRight = new Array<boolean>(rightUnits.length).fill(false);
  const startLeft = new Map<number, AnchorSpan>();
  const startRight = new Map<number, AnchorSpan>();
  const leftIndex = new Map(leftUnits.map((unit, index) => [unit.id, index]));
  const rightIndex = new Map(rightUnits.map((unit, index) => [unit.id, index]));

  for (const span of anchors) {
    if (span.ls != null) startLeft.set(span.ls, span);
    if (span.rs != null) startRight.set(span.rs, span);
    for (const id of span.group.leftIds) {
      const index = leftIndex.get(id);
      if (index != null) anchoredLeft[index] = true;
    }
    for (const id of span.group.rightIds) {
      const index = rightIndex.get(id);
      if (index != null) anchoredRight[index] = true;
    }
  }

  const emitted = new Set<string>();
  let i = 0;
  let j = 0;
  let ops = 0;
  const total = Math.max(1, leftUnits.length + rightUnits.length);

  async function tick() {
    ops += 1;
    if (ops % 24 === 0) {
      onProgress(Math.round(((i + j) / total) * 100));
      await yieldToBrowser();
    }
  }

  function greedyStep(leftBound: number, rightBound: number) {
    if (i >= leftBound) {
      groups.push(makeGroup([], [rightUnits[j]], rules));
      j += 1;
      return;
    }
    if (j >= rightBound) {
      groups.push(makeGroup([leftUnits[i]], [], rules));
      i += 1;
      return;
    }
    const left = leftUnits[i];
    const right = rightUnits[j];
    const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));

    // 组合块不能跨过人工锚点，也不能超出当前空隙边界
    let maxLeft = 1;
    while (maxLeft < rules.candidateWindow && i + maxLeft < leftBound && !anchoredLeft[i + maxLeft]) maxLeft += 1;
    let maxRight = 1;
    while (maxRight < rules.candidateWindow && j + maxRight < rightBound && !anchoredRight[j + maxRight]) maxRight += 1;

    const leftNorms: string[] = [];
    const rightNorms: string[] = [];
    let acc = '';
    for (let a = 0; a < maxLeft; a += 1) {
      acc += normalized(leftUnits[i + a].text, rules);
      leftNorms.push(acc);
    }
    acc = '';
    for (let b = 0; b < maxRight; b += 1) {
      acc += normalized(rightUnits[j + b].text, rules);
      rightNorms.push(acc);
    }

    let best = { a: 1, b: 1, score: ratio };
    for (let a = 1; a <= maxLeft; a += 1) {
      for (let b = 1; b <= maxRight; b += 1) {
        if (a === 1 && b === 1) continue;
        const score = similarity(leftNorms[a - 1], rightNorms[b - 1]);
        if (score > best.score) best = { a, b, score };
      }
    }

    const nextLeftRatio =
      i + 1 < leftBound && !anchoredLeft[i + 1]
        ? similarity(normalized(leftUnits[i + 1].text, rules), normalized(right.text, rules))
        : 0;
    const nextRightRatio =
      j + 1 < rightBound && !anchoredRight[j + 1]
        ? similarity(normalized(left.text, rules), normalized(rightUnits[j + 1].text, rules))
        : 0;
    const sameParagraph = Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;

    // 1. 高度相似，直接一对一
    if (ratio >= 0.86) {
      groups.push(makeGroup([left], [right], rules));
      i += 1;
      j += 1;
      return;
    }
    // 2. 组合块明显更优：一句拆多句、多句并一句或多对多
    if ((best.a > 1 || best.b > 1) && best.score >= 0.5 && best.score > ratio + 0.12) {
      groups.push(makeGroup(leftUnits.slice(i, i + best.a), rightUnits.slice(j, j + best.b), rules));
      i += best.a;
      j += best.b;
      return;
    }
    // 3. 同段且没有更好的邻居，仍按一对一处理
    if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
      groups.push(makeGroup([left], [right], rules));
      i += 1;
      j += 1;
      return;
    }
    // 4. 一侧有插入或缺失，先记单边组
    if (nextRightRatio > ratio && nextRightRatio >= nextLeftRatio) {
      groups.push(makeGroup([], [right], rules));
      j += 1;
    } else {
      groups.push(makeGroup([left], [], rules));
      i += 1;
    }
  }

  while (i < leftUnits.length || j < rightUnits.length) {
    const span = startLeft.get(i) ?? startRight.get(j);
    if (span && !emitted.has(span.group.id)) {
      const gapLeftEnd = span.ls == null ? i : Math.max(span.ls, i);
      const gapRightEnd = span.rs == null ? j : Math.max(span.rs, j);
      while (i < gapLeftEnd || j < gapRightEnd) {
        greedyStep(gapLeftEnd, gapRightEnd);
        await tick();
      }
      groups.push(span.group);
      emitted.add(span.group.id);
      i = span.le == null ? i : Math.max(i, span.le);
      j = span.re == null ? j : Math.max(j, span.re);
      continue;
    }
    if (span) {
      // 已发出的锚点残留索引，直接跳过
      if (i < leftUnits.length && anchoredLeft[i]) {
        i += 1;
        continue;
      }
      if (j < rightUnits.length && anchoredRight[j]) {
        j += 1;
        continue;
      }
    }
    greedyStep(leftUnits.length, rightUnits.length);
    await tick();
  }
  onProgress(100);
  return groups;
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentGroup[]>([]);
  const pending = ref<PendingRecord[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedGroupId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const leftUnitMap = computed(() => new Map((leftVersion.value?.units ?? []).map((unit) => [unit.id, unit])));
  const rightUnitMap = computed(() => new Map((rightVersion.value?.units ?? []).map((unit) => [unit.id, unit])));
  const allUnitMap = computed(() => {
    const map = new Map<string, TextUnit>();
    versions.value.forEach((version) => version.units.forEach((unit) => map.set(unit.id, unit)));
    return map;
  });
  const selectedGroup = computed(() => rows.value.find((item) => item.id === selectedGroupId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);
  const pendingCount = computed(() => pending.value.length);

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      groups: rows.value,
      pending: pending.value,
      rules: rules.value,
      selectedGroupId: selectedGroupId.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, snapshot());
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  let restoring = false;

  function restore(raw: string) {
    restoring = true;
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.groups ?? [];
    pending.value = parsed.pending ?? [];
    rules.value = parsed.rules;
    selectedGroupId.value = parsed.selectedGroupId ?? '';
    persist();
    void nextTick(() => {
      restoring = false;
    });
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const leftUnits = leftVersion.value.units;
      const rightUnits = rightVersion.value.units;
      const manuals = rows.value.filter((group) => group.manual);
      const { anchors, invalid } = buildAnchors(manuals, leftUnits, rightUnits);
      for (const span of anchors) {
        refreshGroup(
          span.group,
          span.group.leftIds.map((id) => leftUnitMap.value.get(id)).filter((unit): unit is TextUnit => Boolean(unit)),
          span.group.rightIds.map((id) => rightUnitMap.value.get(id)).filter((unit): unit is TextUnit => Boolean(unit)),
          rules.value
        );
      }
      const aligned = await alignUnits(leftUnits, rightUnits, rules.value, anchors, (value) => {
        progress.value = value;
      });

      const pendingNext = [...pending.value];
      for (const item of invalid) pendingNext.push(toPending(item.group, item.reason));

      // 旧记录按原句标识迁移：只有唯一归属时才自动并入，否则进入待归属区
      const lookup = new Map<string, AlignmentGroup>();
      for (const group of aligned) {
        group.leftIds.forEach((id) => lookup.set(`L:${id}`, group));
        group.rightIds.forEach((id) => lookup.set(`R:${id}`, group));
      }
      let migrated = 0;
      let orphaned = 0;
      for (const old of rows.value) {
        if (old.manual || !hasContent(old)) continue;
        const keys = [...old.leftIds.map((id) => `L:${id}`), ...old.rightIds.map((id) => `R:${id}`)];
        const surviving = keys.filter((key) => lookup.has(key));
        const targets = [...new Set(surviving.map((key) => lookup.get(key)!))];
        if (targets.length === 1 && surviving.every((key) => lookup.get(key) === targets[0])) {
          mergeAnnotation(targets[0], old.note, old.source, old.accepted);
          migrated += 1;
        } else {
          pendingNext.push(toPending(old, targets.length ? '重排后对应多个分组，无法唯一归属' : '原句段已不存在'));
          orphaned += 1;
        }
      }

      if (commitHistory) {
        history.value.push(previous);
        if (history.value.length > 50) history.value.shift();
        future.value = [];
      }
      rows.value = aligned;
      pending.value = pendingNext;
      selectedGroupId.value = aligned.find((group) => group.status !== 'same')?.id ?? aligned[0]?.id ?? '';
      selectedRowIds.value = [];
      const parts = [`自动对齐完成：${aligned.filter((group) => group.status !== 'same').length} 组差异`];
      if (migrated) parts.push(`${migrated} 条校记已按原句迁移`);
      if (orphaned + invalid.length) parts.push(`${orphaned + invalid.length} 条旧记录进入待归属区`);
      message.value = parts.join('，');
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      const keep: AlignmentGroup[] = [];
      const orphans: PendingRecord[] = [];
      for (const group of rows.value) {
        const leftUnits = group.leftIds.map((id) => leftUnitMap.value.get(id));
        const rightUnits = group.rightIds.map((id) => rightUnitMap.value.get(id));
        if (leftUnits.some((unit) => !unit) || rightUnits.some((unit) => !unit)) {
          // 引用了不存在句段的组整体回到待归属区，不拆成一对一
          orphans.push(toPending(group, '分组引用了不存在的句段'));
          continue;
        }
        refreshGroup(group, leftUnits as TextUnit[], rightUnits as TextUnit[], rules.value);
        keep.push(group);
      }
      rows.value = keep;
      if (orphans.length) pending.value = [...pending.value, ...orphans];
      selectedRowIds.value = [];
    });
  }

  function updateGroup(id: string, patch: Partial<AlignmentGroup>) {
    commit('已更新校勘分组', () => {
      const group = rows.value.find((item) => item.id === id);
      if (group) Object.assign(group, patch, { manual: true });
    });
  }

  /** 合并相邻分组：校记、来源、接受状态随原句标识一起并入新组 */
  function mergeGroups(ids: string[]): boolean {
    const indices = ids
      .map((id) => rows.value.findIndex((group) => group.id === id))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    if (indices.length < 2) return false;
    const contiguous = indices.every((value, k) => k === 0 || value === indices[k - 1] + 1);
    if (!contiguous) {
      message.value = '只能合并相邻的分组';
      return false;
    }
    commit(`已合并 ${indices.length} 个相邻分组`, () => {
      const targets = indices.map((index) => rows.value[index]);
      const leftOrder = new Map((leftVersion.value?.units ?? []).map((unit, index) => [unit.id, index]));
      const rightOrder = new Map((rightVersion.value?.units ?? []).map((unit, index) => [unit.id, index]));
      const leftIds = targets.flatMap((group) => group.leftIds);
      const rightIds = targets.flatMap((group) => group.rightIds);
      leftIds.sort((a, b) => (leftOrder.get(a) ?? 0) - (leftOrder.get(b) ?? 0));
      rightIds.sort((a, b) => (rightOrder.get(a) ?? 0) - (rightOrder.get(b) ?? 0));
      const merged: AlignmentGroup = {
        id: `grp-${Date.now().toString(36)}-merged`,
        leftIds,
        rightIds,
        status: 'same',
        similarity: 0,
        note: targets.map((group) => group.note).filter(Boolean).join('；'),
        source: [...new Set(targets.map((group) => group.source).filter(Boolean))].join('；'),
        accepted: targets.every((group) => group.accepted),
        manual: true
      };
      refreshGroup(
        merged,
        leftIds.map((id) => leftUnitMap.value.get(id)).filter((unit): unit is TextUnit => Boolean(unit)),
        rightIds.map((id) => rightUnitMap.value.get(id)).filter((unit): unit is TextUnit => Boolean(unit)),
        rules.value
      );
      rows.value.splice(indices[0], targets.length, merged);
      selectedGroupId.value = merged.id;
      selectedRowIds.value = [];
    });
    return true;
  }

  /** 从组内拆回单句：原校记没有唯一归属，进入待归属区交人指定 */
  function splitGroup(id: string) {
    const index = rows.value.findIndex((group) => group.id === id);
    if (index < 0) return;
    const group = rows.value[index];
    if (group.leftIds.length <= 1 && group.rightIds.length <= 1) return;
    commit('已把分组拆回单句', () => {
      const leftUnits = group.leftIds
        .map((unitId) => leftUnitMap.value.get(unitId))
        .filter((unit): unit is TextUnit => Boolean(unit));
      const rightUnits = group.rightIds
        .map((unitId) => rightUnitMap.value.get(unitId))
        .filter((unit): unit is TextUnit => Boolean(unit));
      const count = Math.max(leftUnits.length, rightUnits.length);
      const fresh: AlignmentGroup[] = [];
      for (let k = 0; k < count; k += 1) {
        fresh.push(makeGroup(leftUnits[k] ? [leftUnits[k]] : [], rightUnits[k] ? [rightUnits[k]] : [], rules.value));
      }
      rows.value.splice(index, 1, ...fresh);
      if (hasContent(group)) {
        pending.value = [...pending.value, toPending(group, '分组拆回单句，原校记无法唯一归属')];
      }
      selectedGroupId.value = fresh[0]?.id ?? '';
      selectedRowIds.value = [];
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动分组顺序', () => {
      const index = rows.value.findIndex((group) => group.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [group] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, group);
      group.manual = true;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      rows.value.forEach((group) => {
        if (selected.has(group.id)) group.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((group) => {
        group.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((group) => group.id === selectedGroupId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const group = rows.value[index];
      if (group && group.status !== 'same' && !group.accepted) {
        selectedGroupId.value = group.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  /** 待归属区：把旧记录指定到某个分组 */
  function assignPending(pendingId: string, groupId: string) {
    commit('已把待归属记录指定到分组', () => {
      const record = pending.value.find((item) => item.id === pendingId);
      const group = rows.value.find((item) => item.id === groupId);
      if (!record || !group) return;
      mergeAnnotation(group, record.note, record.source, record.accepted);
      group.manual = true;
      pending.value = pending.value.filter((item) => item.id !== pendingId);
    });
  }

  function dismissPending(pendingId: string) {
    commit('已删除待归属记录', () => {
      pending.value = pending.value.filter((item) => item.id !== pendingId);
    });
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  function groupTexts(ids: string[], side: 'left' | 'right') {
    const map = side === 'left' ? leftUnitMap.value : rightUnitMap.value;
    return ids.map((id) => map.get(id)?.text).filter((text): text is string => Boolean(text));
  }

  function numberedTexts(ids: string[], side: 'left' | 'right') {
    const texts = groupTexts(ids, side);
    if (texts.length <= 1) return texts[0] ?? '';
    return texts.map((text, index) => `${index + 1}. ${text}`).join(' ');
  }

  function exportMarkdown() {
    const changed = rows.value.filter((group) => group.status !== 'same' || group.note || group.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      '- 对齐关系：一对一＝底本一句对参校本一句；一对多／多对一＝一句与多句的拆合；多对多＝两侧多句整体对应。',
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 关系 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|---|'
    ];
    changed.forEach((group, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${relationLabel(relationOf(group))} | ${statusLabel(group.status)} | ${cell(numberedTexts(group.leftIds, 'left'))} | ${cell(numberedTexts(group.rightIds, 'right'))} | ${cell(group.note)} | ${cell(group.source)} | ${group.accepted ? '已接受' : '待处理'} |`
      );
    });
    if (pending.value.length) {
      lines.push('', '## 待归属记录', '');
      pending.value.forEach((record, index) => {
        const note = record.note || '（无校记）';
        const source = record.source ? `（来源：${record.source}）` : '';
        lines.push(`${index + 1}. 左 ${record.leftIds.length} 句 / 右 ${record.rightIds.length} 句：${note}${source}——${record.reason}`);
      });
    }
    lines.push(
      '',
      `共 ${changed.length} 条校勘记录${pending.value.length ? `，另有 ${pending.value.length} 条待归属` : ''}。`
    );
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        groups: rows.value.map((group) => ({ ...group, relation: relationOf(group) })),
        pending: pending.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  interface LegacyRow {
    id: string;
    left?: TextUnit;
    right?: TextUnit;
    status: DifferenceStatus;
    similarity: number;
    note?: string;
    source?: string;
    accepted?: boolean;
    manuallyAdjusted?: boolean;
  }

  function migrateLegacy(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw) as Omit<PersistedCollationState, 'groups' | 'pending' | 'selectedGroupId'> & {
        rows: LegacyRow[];
        selectedRowId?: string;
      };
      if (!Array.isArray(parsed.rows)) return null;
      const groups: AlignmentGroup[] = parsed.rows.map((row) => ({
        id: row.id,
        leftIds: row.left ? [row.left.id] : [],
        rightIds: row.right ? [row.right.id] : [],
        status: row.status,
        similarity: row.similarity,
        note: row.note ?? '',
        source: row.source ?? '',
        accepted: Boolean(row.accepted),
        manual: Boolean(row.manuallyAdjusted)
      }));
      const migrated: PersistedCollationState = {
        versions: parsed.versions,
        leftVersionId: parsed.leftVersionId,
        rightVersionId: parsed.rightVersionId,
        groups,
        pending: [],
        rules: parsed.rules,
        selectedGroupId: parsed.selectedRowId ?? ''
      };
      return JSON.stringify(migrated);
    } catch {
      return null;
    }
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
        return;
      }
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      const migrated = legacy ? migrateLegacy(legacy) : null;
      if (migrated) {
        restore(migrated);
        message.value = '已把旧版一对一草稿升级为分组对齐';
        return;
      }
      message.value = '已载入示例版本，正在自动对齐…';
      void runAlignment(false);
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  watch([leftVersionId, rightVersionId], () => {
    if (restoring || processing.value) return;
    void runAlignment();
  });

  return {
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
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
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
    exportJson,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
