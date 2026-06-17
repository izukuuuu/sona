export type CollectPlanDraft = {
  keyword_combination_mode: string;
  boolean_strategy: string;
  keywords_join_with: string;
  platforms: string[];
  time_range: string;
  return_count: number;
  data_num_workers: number;
  data_collect_workers: number;
  analysis_workers: number;
  searchWords_preview: string[];
};

const DEFAULT_COLLECT_PLAN: CollectPlanDraft = {
  keyword_combination_mode: '逐词检索并合并（当前实现）',
  boolean_strategy: 'OR',
  keywords_join_with: ';',
  platforms: ['微博'],
  time_range: '',
  return_count: 2000,
  data_num_workers: 2,
  data_collect_workers: 1,
  analysis_workers: 2,
  searchWords_preview: [],
};

function safeInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[;；,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stripPlugin(payload: Record<string, unknown>) {
  const { plugin, ...rest } = payload;
  void plugin;
  return rest;
}

function normalizeCollectPlan(raw: Record<string, unknown>): CollectPlanDraft {
  return {
    keyword_combination_mode: String(
      raw.keyword_combination_mode || DEFAULT_COLLECT_PLAN.keyword_combination_mode,
    ),
    boolean_strategy: String(raw.boolean_strategy || DEFAULT_COLLECT_PLAN.boolean_strategy),
    keywords_join_with: String(raw.keywords_join_with || DEFAULT_COLLECT_PLAN.keywords_join_with),
    platforms: toStringList(raw.platforms).slice(0, 12) || DEFAULT_COLLECT_PLAN.platforms,
    time_range: String(raw.time_range || ''),
    return_count: Math.max(1, Math.min(safeInt(raw.return_count, DEFAULT_COLLECT_PLAN.return_count), 10000)),
    data_num_workers: Math.max(1, Math.min(safeInt(raw.data_num_workers, DEFAULT_COLLECT_PLAN.data_num_workers), 8)),
    data_collect_workers: Math.max(
      1,
      Math.min(safeInt(raw.data_collect_workers, DEFAULT_COLLECT_PLAN.data_collect_workers), 8),
    ),
    analysis_workers: Math.max(1, Math.min(safeInt(raw.analysis_workers, DEFAULT_COLLECT_PLAN.analysis_workers), 8)),
    searchWords_preview: toStringList(raw.searchWords_preview).slice(0, 10),
  };
}

export function extractCollectPlan(
  payload?: Record<string, unknown>,
  fallbackText = '',
): CollectPlanDraft | null {
  const fromPayload = payload && Object.keys(stripPlugin(payload)).length
    ? normalizeCollectPlan(stripPlugin(payload))
    : null;
  if (fromPayload) return fromPayload;

  const fromText = fallbackText.trim() ? parseJsonObject(fallbackText.trim()) : null;
  return fromText ? normalizeCollectPlan(fromText) : null;
}

export function formatCollectPlanEntries(plan: CollectPlanDraft) {
  return [
    { label: '关键词组合', value: plan.keyword_combination_mode },
    { label: '布尔策略', value: plan.boolean_strategy },
    { label: '关键词连接符', value: plan.keywords_join_with },
    { label: '平台', value: plan.platforms.join('；') || '-' },
    { label: '时间范围', value: plan.time_range || '-' },
    { label: '返回条数', value: String(plan.return_count) },
    { label: 'data_num_workers', value: String(plan.data_num_workers) },
    { label: 'data_collect_workers', value: String(plan.data_collect_workers) },
    { label: 'analysis_workers', value: String(plan.analysis_workers) },
    { label: '检索词预览', value: plan.searchWords_preview.join('；') || '-' },
  ];
}

export function buildCollectPlanPatch(plan: CollectPlanDraft): Record<string, unknown> {
  return {
    keyword_combination_mode: plan.keyword_combination_mode.trim() || DEFAULT_COLLECT_PLAN.keyword_combination_mode,
    boolean_strategy: plan.boolean_strategy.trim() || DEFAULT_COLLECT_PLAN.boolean_strategy,
    keywords_join_with: plan.keywords_join_with.trim() || DEFAULT_COLLECT_PLAN.keywords_join_with,
    platforms: toStringList(plan.platforms).slice(0, 12) || DEFAULT_COLLECT_PLAN.platforms,
    time_range: plan.time_range.trim(),
    return_count: Math.max(1, Math.min(safeInt(plan.return_count, DEFAULT_COLLECT_PLAN.return_count), 10000)),
    data_num_workers: Math.max(1, Math.min(safeInt(plan.data_num_workers, DEFAULT_COLLECT_PLAN.data_num_workers), 8)),
    data_collect_workers: Math.max(
      1,
      Math.min(safeInt(plan.data_collect_workers, DEFAULT_COLLECT_PLAN.data_collect_workers), 8),
    ),
    analysis_workers: Math.max(1, Math.min(safeInt(plan.analysis_workers, DEFAULT_COLLECT_PLAN.analysis_workers), 8)),
    searchWords_preview: toStringList(plan.searchWords_preview).slice(0, 10),
  };
}
