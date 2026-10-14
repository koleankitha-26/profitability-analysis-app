import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  analysesForUser,
  analysisFromSupabase,
  analysisToSupabase,
  reconcileLocalAnalyses,
  saveAnalysisIdempotently,
  type SupabaseAnalysisRow,
} from './analyses'
import { calculateProfitability, type Analysis, type AnalysisInput } from '../utils/profitability'

const input: AnalysisInput = {
  productName: 'Cake',
  customerName: '',
  quantity: 3,
  sellingPrice: 20,
  costPerUnit: 8,
  additionalProductExpenses: 2,
  additionalCustomerExpenses: 1,
  sharedExpenses: 3,
}
const userId = 'user-1'
const recordId = 'analysis-1'
const createdAt = '2026-10-14T12:00:00.000Z'

function makeRow(overrides: Partial<SupabaseAnalysisRow> = {}): SupabaseAnalysisRow {
  return {
    id: recordId,
    user_id: userId,
    product_name: input.productName,
    customer_name: input.customerName,
    quantity_sold: input.quantity,
    selling_price: input.sellingPrice,
    cost_per_unit: input.costPerUnit,
    additional_product_expenses: input.additionalProductExpenses,
    additional_customer_expenses: input.additionalCustomerExpenses,
    allocated_shared_expenses: input.sharedExpenses,
    created_at: createdAt,
    ...overrides,
  }
}

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    ...input,
    ...calculateProfitability(input),
    id: recordId,
    createdAt,
    ...overrides,
  }
}

function createMockClient(options: { failAfterInsert?: boolean; failBeforeInsert?: boolean } = {}) {
  const rows = new Map<string, SupabaseAnalysisRow>()
  let insertCalls = 0
  let failAfterInsert = options.failAfterInsert ?? false
  let failBeforeInsert = options.failBeforeInsert ?? false
  const client = {
    from: () => {
      const filters = new Map<string, string>()
      let inserted: Record<string, unknown> | null = null
      const builder = {
        select: () => builder,
        eq: (key: string, value: string) => {
          filters.set(key, value)
          return builder
        },
        maybeSingle: async () => {
          const row = rows.get(filters.get('id') ?? '')
          return {
            data: row?.user_id === filters.get('user_id') ? row : null,
            error: null,
          }
        },
        insert: (payload: Record<string, unknown>) => {
          insertCalls += 1
          inserted = payload
          return builder
        },
        single: async () => {
          if (!inserted) return { data: null, error: { message: 'No insert payload.' } }
          const row = inserted as unknown as SupabaseAnalysisRow
          if (failBeforeInsert) {
            failBeforeInsert = false
            return { data: null, error: { message: 'Network unavailable.' } }
          }
          if (rows.has(row.id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
          }
          rows.set(row.id, row)
          if (failAfterInsert) {
            failAfterInsert = false
            return { data: null, error: { message: 'Connection dropped after insert.' } }
          }
          return { data: row, error: null }
        },
      }
      return builder
    },
  }
  return {
    client: client as unknown as SupabaseClient,
    rows,
    get insertCalls() { return insertCalls },
  }
}

describe('analysis synchronization', () => {
  it('uses only existing database columns and a stable client-generated row ID', () => {
    const row = analysisToSupabase(input, userId, recordId, createdAt)
    expect(row).toMatchObject({ id: recordId, user_id: userId, product_name: 'Cake' })
    expect(row).not.toHaveProperty('profit')
    expect(row).not.toHaveProperty('margin')
    expect(Object.keys(row)).toEqual([
      'id', 'user_id', 'product_name', 'customer_name', 'quantity_sold',
      'selling_price', 'cost_per_unit', 'additional_product_expenses',
      'additional_customer_expenses', 'allocated_shared_expenses', 'created_at',
    ])
  })

  it('recognizes a previously saved ID even when the fetched timestamp formatting differs', () => {
    const pending = makeAnalysis()
    const remote = analysisFromSupabase(makeRow({ created_at: '2026-10-14T12:00:00Z' }))
    expect(reconcileLocalAnalyses([pending], [remote])).toEqual([])
  })

  it('keeps ambiguous content duplicates pending instead of guessing', () => {
    const local = [
      makeAnalysis({ id: 'local-1' }),
      makeAnalysis({ id: 'local-2' }),
    ]
    const remote = [analysisFromSupabase(makeRow({ id: 'remote-1' }))]
    expect(reconcileLocalAnalyses(local, remote)).toHaveLength(2)
  })

  it('does not treat a reused ID with different data as synchronized', () => {
    const local = [makeAnalysis({ productName: 'Changed cake' })]
    const remote = [analysisFromSupabase(makeRow())]
    expect(reconcileLocalAnalyses(local, remote)).toEqual(local)
  })

  it('does not expose one user’s cached analyses to another user', () => {
    const firstUser = analysisFromSupabase(makeRow({ user_id: 'user-1' }))
    const secondUser = analysisFromSupabase(makeRow({ id: 'analysis-2', user_id: 'user-2' }))
    expect(analysesForUser([firstUser, secondUser], 'user-2')).toEqual([secondUser])
  })

  it('confirms a write after a dropped response and does not insert again on retry', async () => {
    const mock = createMockClient({ failAfterInsert: true })
    const first = await saveAnalysisIdempotently(mock.client, input, userId, recordId, createdAt)
    const second = await saveAnalysisIdempotently(mock.client, input, userId, recordId, createdAt)

    expect(first.id).toBe(recordId)
    expect(second.id).toBe(recordId)
    expect(mock.rows.size).toBe(1)
    expect(mock.insertCalls).toBe(1)
  })

  it('leaves a failed save unconfirmed and successfully recovers it on retry', async () => {
    const mock = createMockClient({ failBeforeInsert: true })
    await expect(
      saveAnalysisIdempotently(mock.client, input, userId, recordId, createdAt),
    ).rejects.toThrow(/Network unavailable/)
    expect(mock.rows.size).toBe(0)

    const recovered = await saveAnalysisIdempotently(mock.client, input, userId, recordId, createdAt)
    expect(recovered.id).toBe(recordId)
    expect(mock.rows.size).toBe(1)
    expect(mock.insertCalls).toBe(2)
  })

  it('does not return or overwrite an ID owned by a different user', async () => {
    const mock = createMockClient()
    mock.rows.set(recordId, makeRow())
    await expect(
      saveAnalysisIdempotently(mock.client, input, 'user-2', recordId, createdAt),
    ).rejects.toThrow(/Could not save this analysis/)
    expect(mock.rows.get(recordId)?.user_id).toBe(userId)
  })
})
