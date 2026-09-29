export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

/**
 * 句组关系。一个句组可以包含多个底本句段与多个参校本句段，
 * 用于描述“底本一句被抄本拆成两三句”或“两段被并作一段”等多对多情况。
 */
export type AlignmentRelation = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

/**
 * 对齐句组。左右两侧都以句段 id 列表引用原文，原文始终保留不被改写。
 * 分组可以是一对一、一对多、多对一或多对多；某一侧为空时表示新增或删减。
 */
export interface AlignmentGroup {
  id: string;
  leftUnitIds: string[];
  rightUnitIds: string[];
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
  /** 人工合并/调整过的句组，规则变化或重新对齐时优先保留 */
  manualGroup: boolean;
}

/** 待归属记录的成因 */
export type PendingReason = 'units-missing' | 'split-across-groups' | 'invalid-group';

/**
 * 待归属校记。旧记录按原句标识迁移时，若找不到唯一归属的句组，
 * 就进入待归属区，由人工指定到某个句组。
 */
export interface PendingAnnotation {
  id: string;
  leftUnitIds: string[];
  rightUnitIds: string[];
  note: string;
  source: string;
  accepted: boolean;
  status: DifferenceStatus;
  reason: PendingReason;
  reasonText: string;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  version: number;
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  groups: AlignmentGroup[];
  pending: PendingAnnotation[];
  rules: ComparisonRules;
  selectedGroupId: string;
}
