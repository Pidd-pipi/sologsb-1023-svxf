export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export type RelationKind = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'left-only' | 'right-only';

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

export interface AlignmentGroup {
  id: string;
  leftIds: string[];
  rightIds: string[];
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manual: boolean;
}

export interface PendingRecord {
  id: string;
  leftIds: string[];
  rightIds: string[];
  note: string;
  source: string;
  accepted: boolean;
  reason: string;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  groups: AlignmentGroup[];
  pending: PendingRecord[];
  rules: ComparisonRules;
  selectedGroupId: string;
}
