import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateProfitability, type Analysis, type AnalysisInput } from '../utils/profitability'

export const ANALYSIS_COLUMNS =
  'id, user_id, product_name, customer_name, quantity_sold, selling_price, cost_per_unit, additional_product_expenses, additional_customer_expenses, allocated_shared_expenses, created_at'

export type SupabaseAnalysisRow = {
  id: string
  user_id: string
  product_name: string
  customer_name: string | null
  quantity_sold: number
  selling_price: number
  cost_per_unit: number
  additional_product_expenses: number
  additional_customer_expenses: number
  allocated_shared_expenses: number
  created_at: string
}

export function analysisFromSupabase(row: SupabaseAnalysisRow): Analysis {
  const input: AnalysisInput = {
    productName: row.product_name,
    customerName: row.customer_name ?? '',
    quantity: Number(row.quantity_sold),
    sellingPrice: Number(row.selling_price),
    costPerUnit: Number(row.cost_per_unit),
    additionalProductExpenses: Number(row.additional_product_expenses),
    additionalCustomerExpenses: Number(row.additional_customer_expenses),
    sharedExpenses: Number(row.allocated_shared_expenses),
  }

  return {
    ...input,
    ...calculateProfitability(input),
    id: row.id,
    createdAt: row.created_at,
    syncUserId: row.user_id,
    syncStatus: 'synced',
  }
}

export function analysisToSupabase(input: AnalysisInput, userId: string, id: string, createdAt: string) {
  return {
    id,
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
  }
}

export async function saveAnalysisIdempotently(
  client: SupabaseClient,
  input: AnalysisInput,
  userId: string,
  id: string,
  createdAt: string,
): Promise<SupabaseAnalysisRow> {
  const findById = async () => {
    const { data, error } = await client
      .from('analyses')
      .select(ANALYSIS_COLUMNS)
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new Error(`Could not verify the existing analysis in Supabase: ${error.message}`)
    return data as SupabaseAnalysisRow | null
  }

  const existing = await findById()
  if (existing) {
    assertSameAnalysis(existing, input, createdAt)
    return existing
  }

  const { data, error } = await client
    .from('analyses')
    .insert(analysisToSupabase(input, userId, id, createdAt))
    .select(ANALYSIS_COLUMNS)
    .single()

  if (error || !data) {
    const recovered = await findById().catch((verificationError: unknown) => {
      const message = verificationError instanceof Error
        ? verificationError.message
        : 'Could not verify whether the save reached Supabase.'
      throw new Error(`${error?.message ?? 'Supabase returned no saved row.'} ${message}`)
    })
    if (recovered) {
      assertSameAnalysis(recovered, input, createdAt)
      return recovered
    }
    throw new Error(`Could not save this analysis to Supabase: ${error?.message ?? 'No row was returned.'}`)
  }

  if (data.user_id !== userId || data.id !== id) {
    throw new Error('Supabase returned an analysis row that does not match the requested ID and signed-in user.')
  }
  assertSameAnalysis(data as SupabaseAnalysisRow, input, createdAt)
  return data as SupabaseAnalysisRow
}

export function analysisSignature(analysis: Analysis) {
  return JSON.stringify([
    analysisContentSignature(analysis),
    Date.parse(analysis.createdAt),
  ])
}

export function analysisContentSignature(analysis: Analysis) {
  return JSON.stringify([
    analysis.productName,
    analysis.customerName,
    analysis.quantity,
    analysis.sellingPrice,
    analysis.costPerUnit,
    analysis.additionalProductExpenses,
    analysis.additionalCustomerExpenses,
    analysis.sharedExpenses,
  ])
}

export function analysesForUser(analyses: Analysis[], userId: string) {
  return analyses.filter((analysis) => analysis.syncUserId === userId)
}

export function reconcileLocalAnalyses(local: Analysis[], remote: Analysis[]) {
  const unmatchedLocal = [...local]
  const unmatchedRemote = [...remote]
  consumeMatches(
    unmatchedLocal,
    unmatchedRemote,
    (analysis) => JSON.stringify([analysis.id, analysisContentSignature(analysis)]),
  )
  consumeMatches(unmatchedLocal, unmatchedRemote, analysisSignature)
  consumeMatches(unmatchedLocal, unmatchedRemote, analysisContentSignature)
  return unmatchedLocal
}

function assertSameAnalysis(row: SupabaseAnalysisRow, input: AnalysisInput, createdAt: string) {
  const saved = analysisFromSupabase(row)
  if (analysisContentSignature(saved) !== analysisContentSignature({ ...input, ...calculateProfitability(input), id: row.id, createdAt: row.created_at })
    || Date.parse(saved.createdAt) !== Date.parse(createdAt)) {
    throw new Error(`Analysis ID ${row.id} already exists with different data. No existing record was overwritten.`)
  }
}

function countSignatures<T>(items: T[], getSignature: (item: T) => string) {
  const counts = new Map<string, number>()
  for (const item of items) {
    const signature = getSignature(item)
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return counts
}

function consumeMatches(
  local: Analysis[],
  remote: Analysis[],
  getSignature: (analysis: Analysis) => string,
) {
  const localCounts = countSignatures(local, getSignature)
  const remoteCounts = countSignatures(remote, getSignature)
  const matchable = new Set([...localCounts]
    .filter(([signature, count]) => count === 1 && remoteCounts.get(signature) === 1)
    .map(([signature]) => signature))

  for (const signature of matchable) {
    const localIndex = local.findIndex((analysis) => getSignature(analysis) === signature)
    const remoteIndex = remote.findIndex((analysis) => getSignature(analysis) === signature)
    if (localIndex !== -1 && remoteIndex !== -1) {
      local.splice(localIndex, 1)
      remote.splice(remoteIndex, 1)
    }
  }
}
