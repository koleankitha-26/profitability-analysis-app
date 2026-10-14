import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_DRAFT_KEY,
  clearAnalysisDraft,
  loadAnalysisDraft,
  saveAnalysisDraft,
  type AnalysisDraft,
} from './analysisDraft'

const draft: AnalysisDraft = {
  productName: 'Cake',
  quantity: '4',
  sellingPrice: '25.50',
  costPerUnit: '12',
  customerName: 'Customer',
  additionalProductExpenses: '2',
  additionalCustomerExpenses: '',
  sharedExpenses: '1',
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('New Analysis draft storage', () => {
  it('stores and restores partial values under a dedicated session key', () => {
    const storage = memoryStorage()
    saveAnalysisDraft(storage, draft)

    expect(ANALYSIS_DRAFT_KEY).toBe('profitability-analysis-draft')
    expect(storage.values.has(ANALYSIS_DRAFT_KEY)).toBe(true)
    expect(loadAnalysisDraft(storage)).toEqual(draft)
  })

  it('rejects malformed drafts without treating them as completed analysis data', () => {
    const storage = memoryStorage()
    storage.setItem(ANALYSIS_DRAFT_KEY, JSON.stringify({ productName: 'Incomplete' }))

    expect(loadAnalysisDraft(storage)).toBeNull()
  })

  it('clears only the draft when explicitly requested', () => {
    const storage = memoryStorage()
    saveAnalysisDraft(storage, draft)

    expect(clearAnalysisDraft(storage)).toBe(true)
    expect(storage.getItem(ANALYSIS_DRAFT_KEY)).toBeNull()
  })
})
