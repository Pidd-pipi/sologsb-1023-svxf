import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentGroup,
  ComparisonRules,
  DifferenceStatus,
  PendingAnnotation,
  PendingReason,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const MAX_GROUP = 4;
const PAIR_FLOOR = 0.28;

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
    globalThis.setTimeout(resolve, 0);
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

function unitsText(units: TextUnit[], rules: ComparisonRules): string {
  return units.map((unit) => normalized(unit.text, rules)).join('');
}

function statusFor(leftCount: number, rightCount: number, ratio: number): DifferenceStatus {
  if (!leftCount) return 'added';
  if (!rightCount) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

export function makeGroup(
  lefts: TextUnit[],
  rights: TextUnit[],
  rules: ComparisonRules,
  manualGroup = false
): AlignmentGroup {
  const score =
    lefts.length && rights.length
      ? Number(similarity(unitsText(lefts, rules), unitsText(rights, rules)).toFixed(3))
      : 0;
  return {
    id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    leftUnitIds: lefts.map((unit) => unit.id),
    rightUnitIds: rights.map((unit) => unit.id),
    status: statusFor(lefts.length, rights.length, score),
    similarity: score,
    note: '',
    source: '',
    accepted: score > 0.995,
    manuallyAdjusted: false,
    manualGroup
  };
}

/**
 * 分片自动对齐。在原有双指针配对的基础上向前探查，把“一句拆成两三句”
 * （一对多）或“两段并作一段”（多对一）合并进同一个句组；其余仍按
 * 新增 / 删减处理。每处理 24 个句段让出一次主线程并回报进度。
 */
export async function alignGroups(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentGroup[]> {
  const groups: AlignmentGroup[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  const total = leftUnits.length + rightUnits.length;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      groups.push(makeGroup([], [right], rules));
      rightIndex += 1;
    } else if (!right) {
      groups.push(makeGroup([left], [], rules));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));

      // 向前探查：一对多（一个底本句对应多个参校本句）
      let splitRightCount = 0;
      let splitRightScore = ratio;
      for (let offset = 1; offset < MAX_GROUP && rightIndex + offset < rightUnits.length; offset += 1) {
        const score =
          similarity(normalized(left.text, rules), unitsText(rightUnits.slice(rightIndex, rightIndex + offset + 1), rules)) -
          0.02 * offset;
        if (score > splitRightScore + 0.03) {
          splitRightScore = score;
          splitRightCount = offset;
        }
      }

      // 向前探查：多对一（多个底本句对应一个参校本句）
      let mergeLeftCount = 0;
      let mergeLeftScore = splitRightScore;
      for (let offset = 1; offset < MAX_GROUP && leftIndex + offset < leftUnits.length; offset += 1) {
        const score =
          similarity(unitsText(leftUnits.slice(leftIndex, leftIndex + offset + 1), rules), normalized(right.text, rules)) -
          0.02 * offset;
        if (score > mergeLeftScore + 0.03) {
          mergeLeftScore = score;
          mergeLeftCount = offset;
        }
      }

      if (splitRightCount > 0 && (mergeLeftCount === 0 || splitRightScore >= mergeLeftScore)) {
        const rights = rightUnits.slice(rightIndex, rightIndex + splitRightCount + 1);
        groups.push(makeGroup([left], rights, rules));
        leftIndex += 1;
        rightIndex += splitRightCount + 1;
      } else if (mergeLeftCount > 0) {
        const lefts = leftUnits.slice(leftIndex, leftIndex + mergeLeftCount + 1);
        groups.push(makeGroup(lefts, [right], rules));
        leftIndex += mergeLeftCount + 1;
        rightIndex += 1;
      } else {
        const nextLeftRatio =
          leftUnits[leftIndex + 1] && right
            ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
            : 0;
        const nextRightRatio =
          rightUnits[rightIndex + 1] && left
            ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
            : 0;

        if (sameParagraph && (ratio >= PAIR_FLOOR || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
          groups.push(makeGroup([left], [right], rules));
          leftIndex += 1;
          rightIndex += 1;
        } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
          groups.push(makeGroup([], [right], rules));
          rightIndex += 1;
        } else {
          groups.push(makeGroup([left], [], rules));
          leftIndex += 1;
        }
      }
    }

    if (groups.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, total)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return groups;
}

/** 句组关系，用于导出与界面展示。 */
export function relationOf(group: AlignmentGroup): 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' {
  const left = group.leftUnitIds.length;
  const right = group.rightUnitIds.length;
  if (left === 1 && right === 1) return 'one-to-one';
  if (left === 1 && right > 1) return 'one-to-many';
  if (left > 1 && right === 1) return 'many-to-one';
  return 'many-to-many';
}

export function relationLabel(group: AlignmentGroup): string {
  const left = group.leftUnitIds.length;
  const right = group.rightUnitIds.length;
  if (left === 1 && right === 1) return '一对一';
  if (left === 0 && right > 0) return '新增';
  if (left > 0 && right === 0) return '删减';
  if (left === 1 && right > 1) return '一对多';
  if (left > 1 && right === 1) return '多对一';
  return '多对多';
}

interface AnnotationCarrier {
  leftUnitIds: string[];
  rightUnitIds: string[];
  note: string;
  source: string;
  accepted: boolean;
  status: DifferenceStatus;
  manuallyAdjusted: boolean;
}

function groupToCarrier(group: AlignmentGroup): AnnotationCarrier {
  return {
    leftUnitIds: [...group.leftUnitIds],
    rightUnitIds: [...group.rightUnitIds],
    note: group.note,
    source: group.source,
    accepted: group.accepted,
    status: group.status,
    manuallyAdjusted: group.manuallyAdjusted
  };
}

function pendingToCarrier(pending: PendingAnnotation): AnnotationCarrier {
  return {
    leftUnitIds: [...pending.leftUnitIds],
    rightUnitIds: [...pending.rightUnitIds],
    note: pending.note,
    source: pending.source,
    accepted: pending.accepted,
    status: pending.status,
    manuallyAdjusted: false
  };
}

function carrierHasContent(carrier: AnnotationCarrier): boolean {
  return Boolean(carrier.note || carrier.source || carrier.accepted);
}

function toPending(
  carrier: AnnotationCarrier,
  reason: PendingReason,
  reasonText: string
): PendingAnnotation {
  return {
    id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    leftUnitIds: [...carrier.leftUnitIds],
    rightUnitIds: [...carrier.rightUnitIds],
    note: carrier.note,
    source: carrier.source,
    accepted: carrier.accepted,
    status: carrier.status,
    reason,
    reasonText
  };
}

/**
 * 按原句标识迁移校记、来源与接受状态。
 * 能在某个句组中找到全部引用句段（唯一归属）则并入该组；
 * 引用了不存在句段或句段被拆分到多个分组而无法唯一归属时，进入待归属区。
 */
export function attributeCarriers(
  carriers: AnnotationCarrier[],
  groups: AlignmentGroup[],
  leftUnits: TextUnit[],
  rightUnits: TextUnit[]
): { groups: AlignmentGroup[]; pending: PendingAnnotation[] } {
  const leftIds = new Set(leftUnits.map((unit) => unit.id));
  const rightIds = new Set(rightUnits.map((unit) => unit.id));

  for (const group of groups) {
    group.note = '';
    group.source = '';
    group.accepted = false;
  }

  const pending: PendingAnnotation[] = [];
  for (const carrier of carriers) {
    const missingLeft = carrier.leftUnitIds.filter((id) => !leftIds.has(id));
    const missingRight = carrier.rightUnitIds.filter((id) => !rightIds.has(id));
    if (missingLeft.length || missingRight.length) {
      if (carrierHasContent(carrier)) {
        pending.push(
          toPending(
            carrier,
            'units-missing',
            `引用了不存在的句段（${[...missingLeft, ...missingRight].join('、')}），无法唯一归属`
          )
        );
      }
      continue;
    }

    const match = groups.find(
      (group) =>
        carrier.leftUnitIds.every((id) => group.leftUnitIds.includes(id)) &&
        carrier.rightUnitIds.every((id) => group.rightUnitIds.includes(id))
    );
    if (!match) {
      if (carrierHasContent(carrier)) {
        pending.push(
          toPending(carrier, 'split-across-groups', '句段被拆分到多个分组，找不到唯一归属')
        );
      }
      continue;
    }

    if (carrier.note) match.note = match.note ? `${match.note}\n${carrier.note}` : carrier.note;
    if (carrier.source) match.source = match.source ? `${match.source}\n${carrier.source}` : carrier.source;
    if (carrier.accepted) match.accepted = true;
    if (carrier.manuallyAdjusted) match.manuallyAdjusted = true;
  }

  return { groups, pending };
}

function groupUnitsExist(group: AlignmentGroup, leftUnits: TextUnit[], rightUnits: TextUnit[]): boolean {
  const leftIds = new Set(leftUnits.map((unit) => unit.id));
  const rightIds = new Set(rightUnits.map((unit) => unit.id));
  return (
    group.leftUnitIds.every((id) => leftIds.has(id)) && group.rightUnitIds.every((id) => rightIds.has(id))
  );
}

function recomputeGroup(
  group: AlignmentGroup,
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules
): AlignmentGroup {
  const lefts = group.leftUnitIds
    .map((id) => leftUnits.find((unit) => unit.id === id))
    .filter((unit): unit is TextUnit => Boolean(unit));
  const rights = group.rightUnitIds
    .map((id) => rightUnits.find((unit) => unit.id === id))
    .filter((unit): unit is TextUnit => Boolean(unit));
  const score =
    lefts.length && rights.length
      ? Number(similarity(unitsText(lefts, rules), unitsText(rights, rules)).toFixed(3))
      : 0;
  return { ...group, similarity: score, status: statusFor(lefts.length, rights.length, score) };
}

function mergeGroupsInOrder(
  freeGroups: AlignmentGroup[],
  manualGroups: AlignmentGroup[],
  leftUnits: TextUnit[],
  rightUnits: TextUnit[]
): AlignmentGroup[] {
  const leftIndex = new Map(leftUnits.map((unit, index) => [unit.id, index]));
  const rightIndex = new Map(rightUnits.map((unit, index) => [unit.id, index]));
  const orderKey = (group: AlignmentGroup): [number, number] => {
    const leftKey = group.leftUnitIds.length
      ? Math.min(...group.leftUnitIds.map((id) => leftIndex.get(id) ?? Number.POSITIVE_INFINITY))
      : Number.POSITIVE_INFINITY;
    const rightKey = group.rightUnitIds.length
      ? Math.min(...group.rightUnitIds.map((id) => rightIndex.get(id) ?? Number.POSITIVE_INFINITY))
      : Number.POSITIVE_INFINITY;
    return [leftKey, rightKey];
  };
  return [...freeGroups, ...manualGroups].sort((a, b) => {
    const [aLeft, aRight] = orderKey(a);
    const [bLeft, bRight] = orderKey(b);
    return aLeft - bLeft || aRight - bRight;
  });
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const groups = ref<AlignmentGroup[]>([]);
  const pending = ref<PendingAnnotation[]>([]);
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
  const selectedGroup = computed(() => groups.value.find((item) => item.id === selectedGroupId.value));
  const differenceCount = computed(() => groups.value.filter((group) => group.status !== 'same').length);
  const acceptedCount = computed(() => groups.value.filter((group) => group.accepted).length);
  const unresolvedCount = computed(
    () => groups.value.filter((group) => !group.accepted && group.status !== 'same').length
  );

  function leftUnitsOf(group: AlignmentGroup): TextUnit[] {
    const units = leftVersion.value?.units ?? [];
    return group.leftUnitIds
      .map((id) => units.find((unit) => unit.id === id))
      .filter((unit): unit is TextUnit => Boolean(unit));
  }

  function rightUnitsOf(group: AlignmentGroup): TextUnit[] {
    const units = rightVersion.value?.units ?? [];
    return group.rightUnitIds
      .map((id) => units.find((unit) => unit.id === id))
      .filter((unit): unit is TextUnit => Boolean(unit));
  }

  function snapshot(): string {
    const data: PersistedCollationState = {
      version: 2,
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      groups: groups.value,
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

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState & { rows?: unknown[] };
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rules.value = parsed.rules;

    if (Array.isArray(parsed.groups)) {
      groups.value = parsed.groups;
      pending.value = parsed.pending ?? [];
      selectedGroupId.value = parsed.selectedGroupId ?? '';
    } else if (Array.isArray(parsed.rows)) {
      // 兼容 v1 的 1:1 行数据，迁移为句组并按句段标识归属校记。
      const leftUnits = versions.value.find((item) => item.id === parsed.leftVersionId)?.units ?? [];
      const rightUnits = versions.value.find((item) => item.id === parsed.rightVersionId)?.units ?? [];
      const migrated: AlignmentGroup[] = [];
      for (const row of parsed.rows as Array<Record<string, unknown>>) {
        const left = row.left as TextUnit | undefined;
        const right = row.right as TextUnit | undefined;
        migrated.push({
          id: String(row.id ?? `group-${Date.now().toString(36)}`),
          leftUnitIds: left ? [left.id] : [],
          rightUnitIds: right ? [right.id] : [],
          status: (row.status as DifferenceStatus) ?? 'misaligned',
          similarity: Number(row.similarity ?? 0),
          note: String(row.note ?? ''),
          source: String(row.source ?? ''),
          accepted: Boolean(row.accepted),
          manuallyAdjusted: Boolean(row.manuallyAdjusted),
          manualGroup: false
        });
      }
      const result = attributeCarriers(
        migrated.map(groupToCarrier),
        migrated,
        leftUnits,
        rightUnits
      );
      groups.value = result.groups;
      pending.value = result.pending;
      selectedGroupId.value = String((parsed as { selectedRowId?: string }).selectedRowId ?? '');
    } else {
      groups.value = [];
      pending.value = [];
      selectedGroupId.value = '';
    }
    persist();
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

      const oldCarriers = groups.value.map(groupToCarrier);
      const manualGroups = groups.value.filter((group) => group.manualGroup);
      const validManual: AlignmentGroup[] = [];
      for (const manual of manualGroups) {
        if (groupUnitsExist(manual, leftUnits, rightUnits)) validManual.push(manual);
        // 引用了不存在句段的人工分组不锁定任何句段，其校记稍后进入待归属。
      }

      // 人工分组优先：锁定其引用的句段，其余句段重新自动对齐。
      const lockedLeft = new Set(validManual.flatMap((group) => group.leftUnitIds));
      const lockedRight = new Set(validManual.flatMap((group) => group.rightUnitIds));
      const freeLeft = leftUnits.filter((unit) => !lockedLeft.has(unit.id));
      const freeRight = rightUnits.filter((unit) => !lockedRight.has(unit.id));

      const freeGroups = await alignGroups(freeLeft, freeRight, rules.value, (value) => {
        progress.value = value;
      });
      const keptManual = validManual.map((group) => recomputeGroup(group, leftUnits, rightUnits, rules.value));
      const merged = mergeGroupsInOrder(freeGroups, keptManual, leftUnits, rightUnits);

      const carriers = [
        ...oldCarriers,
        ...pending.value.map(pendingToCarrier)
      ];
      const result = attributeCarriers(carriers, merged, leftUnits, rightUnits);
      groups.value = result.groups;
      pending.value = result.pending;

      selectedGroupId.value =
        groups.value.find((group) => group.status !== 'same')?.id ?? groups.value[0]?.id ?? '';
      selectedRowIds.value = [];
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      message.value = `自动对齐完成：${groups.value.filter((group) => group.status !== 'same').length} 处差异`;
      if (pending.value.length) message.value += `，${pending.value.length} 条待归属`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      const leftUnits = leftVersion.value?.units ?? [];
      const rightUnits = rightVersion.value?.units ?? [];
      // 规则变化只重算相似度与类别，保留人工分组与校记；人工分组不被拆散。
      groups.value = groups.value.map((group) => recomputeGroup(group, leftUnits, rightUnits, rules.value));
      selectedRowIds.value = [];
    });
  }

  function updateGroup(id: string, patch: Partial<AlignmentGroup>) {
    commit('已更新校勘句组', () => {
      const group = groups.value.find((item) => item.id === id);
      if (group) Object.assign(group, patch, { manuallyAdjusted: true });
    });
  }

  /** 合并相邻的多个句组为一个多对多句组。 */
  function mergeGroups(ids: string[]) {
    if (ids.length < 2) return;
    const indices = ids
      .map((id) => groups.value.findIndex((group) => group.id === id))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    if (indices.length < 2) return;
    for (let cursor = 1; cursor < indices.length; cursor += 1) {
      if (indices[cursor] !== indices[cursor - 1] + 1) {
        message.value = '只能合并相邻的行';
        return;
      }
    }
    commit('已合并相邻句组', () => {
      const ordered = indices.map((index) => groups.value[index]);
      const leftIds = ordered.flatMap((group) => group.leftUnitIds);
      const rightIds = ordered.flatMap((group) => group.rightUnitIds);
      const lefts = leftIds
        .map((id) => leftVersion.value?.units.find((unit) => unit.id === id))
        .filter((unit): unit is TextUnit => Boolean(unit));
      const rights = rightIds
        .map((id) => rightVersion.value?.units.find((unit) => unit.id === id))
        .filter((unit): unit is TextUnit => Boolean(unit));
      const score =
        lefts.length && rights.length
          ? Number(similarity(unitsText(lefts, rules.value), unitsText(rights, rules.value)).toFixed(3))
          : 0;
      const merged: AlignmentGroup = {
        id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        leftUnitIds: leftIds,
        rightUnitIds: rightIds,
        status: statusFor(lefts.length, rights.length, score),
        similarity: score,
        note: ordered.map((group) => group.note).filter(Boolean).join('\n'),
        source: ordered.map((group) => group.source).filter(Boolean).join('\n'),
        accepted: ordered.some((group) => group.accepted),
        manuallyAdjusted: true,
        manualGroup: true
      };
      groups.value.splice(indices[0], indices.length, merged);
      selectedRowIds.value = [];
      selectedGroupId.value = merged.id;
    });
  }

  /** 把句组拆回单句；引用了不存在句段的组无法拆成一对一，转入待归属。 */
  function splitGroup(id: string) {
    const group = groups.value.find((item) => item.id === id);
    if (!group) return;
    const leftUnits = leftVersion.value?.units ?? [];
    const rightUnits = rightVersion.value?.units ?? [];
    const lefts = group.leftUnitIds
      .map((gid) => leftUnits.find((unit) => unit.id === gid))
      .filter((unit): unit is TextUnit => Boolean(unit));
    const rights = group.rightUnitIds
      .map((gid) => rightUnits.find((unit) => unit.id === gid))
      .filter((unit): unit is TextUnit => Boolean(unit));

    if (lefts.length !== group.leftUnitIds.length || rights.length !== group.rightUnitIds.length) {
      commit('分组引用了不存在的句段，已转入待归属', () => {
        groups.value = groups.value.filter((item) => item.id !== id);
        const carrier = groupToCarrier(group);
        if (carrierHasContent(carrier)) {
          pending.value.push(
            toPending(carrier, 'invalid-group', '分组引用了不存在的句段，无法拆成单句，已转入待归属')
          );
        }
        if (selectedGroupId.value === id) selectedGroupId.value = '';
      });
      return;
    }

    commit('已将句组拆回单句', () => {
      const index = groups.value.findIndex((item) => item.id === id);
      const children: AlignmentGroup[] = [];
      const count = Math.max(lefts.length, rights.length);
      for (let cursor = 0; cursor < count; cursor += 1) {
        const left = lefts[cursor];
        const right = rights[cursor];
        children.push(makeGroup(left ? [left] : [], right ? [right] : [], rules.value));
      }
      groups.value.splice(index, 1, ...children);
      const result = attributeCarriers([groupToCarrier(group)], children, leftUnits, rightUnits);
      pending.value.push(...result.pending);
      selectedRowIds.value = [];
      selectedGroupId.value = children[0]?.id ?? '';
    });
  }

  /** 待归属记录指定到某个句组。 */
  function assignPending(pendingId: string, groupId: string) {
    commit('已将待归属校记指派到句组', () => {
      const item = pending.value.find((entry) => entry.id === pendingId);
      const group = groups.value.find((entry) => entry.id === groupId);
      if (!item || !group) return;
      if (item.note) group.note = group.note ? `${group.note}\n${item.note}` : item.note;
      if (item.source) group.source = group.source ? `${group.source}\n${item.source}` : item.source;
      if (item.accepted) group.accepted = true;
      group.manuallyAdjusted = true;
      pending.value = pending.value.filter((entry) => entry.id !== pendingId);
    });
  }

  function discardPending(pendingId: string) {
    commit('已丢弃待归属校记', () => {
      pending.value = pending.value.filter((entry) => entry.id !== pendingId);
    });
  }

  function moveGroup(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = groups.value.findIndex((group) => group.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= groups.value.length) return;
      const [moved] = groups.value.splice(index, 1);
      groups.value.splice(targetIndex, 0, moved);
      moved.manuallyAdjusted = true;
    });
  }

  /** 交换相邻两个句组的底本句段，用于修正配对错位。 */
  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = groups.value.findIndex((group) => group.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= groups.value.length) return;
      const current = groups.value[index];
      const target = groups.value[targetIndex];
      const currentLeft = current.leftUnitIds;
      current.leftUnitIds = target.leftUnitIds;
      target.leftUnitIds = currentLeft;
      for (const group of [current, target]) {
        const lefts = group.leftUnitIds
          .map((gid) => leftVersion.value?.units.find((unit) => unit.id === gid))
          .filter((unit): unit is TextUnit => Boolean(unit));
        const rights = group.rightUnitIds
          .map((gid) => rightVersion.value?.units.find((unit) => unit.id === gid))
          .filter((unit): unit is TextUnit => Boolean(unit));
        const score =
          lefts.length && rights.length
            ? Number(similarity(unitsText(lefts, rules.value), unitsText(rights, rules.value)).toFixed(3))
            : 0;
        group.similarity = score;
        group.status = statusFor(lefts.length, rights.length, score);
        group.manuallyAdjusted = true;
      }
    });
  }

  function acceptGroups(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      groups.value.forEach((group) => {
        if (selected.has(group.id)) group.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      groups.value.forEach((group) => {
        group.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = groups.value.findIndex((group) => group.id === selectedGroupId.value);
    for (let offset = 1; offset <= groups.value.length; offset += 1) {
      const index = (start + offset) % groups.value.length;
      const group = groups.value[index];
      if (group && group.status !== 'same' && !group.accepted) {
        selectedGroupId.value = group.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
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
  }

  function groupCell(units: TextUnit[]): string {
    return units.map((unit) => unit.text).join(' ║ ');
  }

  function exportMarkdown() {
    const changed = groups.value.filter(
      (group) => group.status !== 'same' || group.note || group.source
    );
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 关系 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|---|'
    ];
    changed.forEach((group, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${relationLabel(group)} | ${statusLabel(group.status)} | ${cell(groupCell(leftUnitsOf(group)))} | ${cell(groupCell(rightUnitsOf(group)))} | ${cell(group.note)} | ${cell(group.source)} | ${group.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    if (pending.value.length) {
      lines.push('', `另有 ${pending.value.length} 条待归属校记未写入正文，请在工具中指定句组后再导出。`);
    }
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        version: 2,
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        groups: groups.value.map((group) => ({
          ...group,
          relation: relationOf(group),
          relationLabel: relationLabel(group),
          leftText: groupCell(leftUnitsOf(group)),
          rightText: groupCell(rightUnitsOf(group))
        })),
        pending: pending.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  watch([leftVersionId, rightVersionId], () => {
    if (!processing.value) void runAlignment();
  });

  watch(
    [() => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) persist();
    }
  );

  return {
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
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
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
