export type AnalysisInput = {
  productName: string
  quantity: number
  sellingPrice: number
  costPerUnit: number
  customerName: string
  additionalProductExpenses: number
  additionalCustomerExpenses: number
  sharedExpenses: number
}

export type Analysis = AnalysisInput & {
  id: string
  createdAt: string
  revenue: number
  directCost: number
  totalCost: number
  profit: number
  margin: number | null
  syncUserId?: string
  syncStatus?: 'pending' | 'synced'
}

export type ProfitabilityResult = {
  revenue: number
  directCost: number
  totalCost: number
  profit: number
  margin: number | null
}

export function calculateProfitability(input: AnalysisInput): ProfitabilityResult {
  validateAnalysisInput(input)
  const revenue = input.quantity * input.sellingPrice
  const directCost = input.quantity * input.costPerUnit
  const totalCost = directCost + input.additionalProductExpenses + input.additionalCustomerExpenses + input.sharedExpenses
  const profit = revenue - totalCost
  const values = [revenue, directCost, totalCost, profit]
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new Error('These values are too large to calculate safely. Check the quantity and amounts.')
  }

  const margin = revenue === 0 ? 0 : (profit / revenue) * 100
  if (!Number.isFinite(margin)) {
    throw new Error('These values are too large to calculate a safe profit margin.')
  }

  return {
    revenue,
    directCost,
    totalCost,
    profit,
    margin,
  }
}

export function validateAnalysisInput(input: AnalysisInput) {
  if (!input.productName.trim()) {
    throw new Error('Enter a product or service name.')
  }
  if (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > Number.MAX_SAFE_INTEGER) {
    throw new Error('Quantity must be a positive finite value within the safe calculation range.')
  }
  const amounts = [
    input.sellingPrice,
    input.costPerUnit,
    input.additionalProductExpenses,
    input.additionalCustomerExpenses,
    input.sharedExpenses,
  ]
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0)) {
    throw new Error('Prices and expenses must be finite amounts of zero or more.')
  }
  if (amounts.some((amount) => amount > Number.MAX_SAFE_INTEGER)) {
    throw new Error('An amount is too large to calculate safely.')
  }
}
