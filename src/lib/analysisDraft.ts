export const ANALYSIS_DRAFT_KEY = 'profitability-analysis-draft'

export type AnalysisDraft = {
  productName: string
  quantity: string
  sellingPrice: string
  costPerUnit: string
  customerName: string
  additionalProductExpenses: string
  additionalCustomerExpenses: string
  sharedExpenses: string
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const DRAFT_FIELDS: (keyof AnalysisDraft)[] = [
  'productName',
  'quantity',
  'sellingPrice',
  'costPerUnit',
  'customerName',
  'additionalProductExpenses',
  'additionalCustomerExpenses',
  'sharedExpenses',
]

export function loadAnalysisDraft(storage: DraftStorage): AnalysisDraft | null {
  const raw = storage.getItem(ANALYSIS_DRAFT_KEY)
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const values = parsed as Record<string, unknown>
    if (!DRAFT_FIELDS.every((field) => typeof values[field] === 'string')) return null
    return Object.fromEntries(DRAFT_FIELDS.map((field) => [field, values[field]])) as AnalysisDraft
  } catch {
    return null
  }
}

export function saveAnalysisDraft(storage: DraftStorage, draft: AnalysisDraft) {
  storage.setItem(ANALYSIS_DRAFT_KEY, JSON.stringify(draft))
}

export function clearAnalysisDraft(storage: DraftStorage) {
  try {
    storage.removeItem(ANALYSIS_DRAFT_KEY)
    return true
  } catch {
    return false
  }
}
