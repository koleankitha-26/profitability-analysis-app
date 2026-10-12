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
}

export function calculateProfitability(input: AnalysisInput): Omit<Analysis, keyof AnalysisInput | 'id' | 'createdAt'> {
  const revenue = input.quantity * input.sellingPrice
  const directCost = input.quantity * input.costPerUnit
  const totalCost = directCost + input.additionalProductExpenses + input.additionalCustomerExpenses + input.sharedExpenses
  const profit = revenue - totalCost

  return {
    revenue,
    directCost,
    totalCost,
    profit,
    margin: revenue === 0 ? 0 : (profit / revenue) * 100,
  }
}
