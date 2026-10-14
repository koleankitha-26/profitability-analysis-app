import { describe, expect, it } from 'vitest'
import { calculateProfitability, type AnalysisInput } from './profitability'

const input: AnalysisInput = {
  productName: 'Test product',
  customerName: 'Test customer',
  quantity: 10,
  sellingPrice: 25,
  costPerUnit: 12,
  additionalProductExpenses: 10,
  additionalCustomerExpenses: 5,
  sharedExpenses: 5,
}

describe('calculateProfitability', () => {
  it('calculates revenue, direct cost, total cost, profit, and margin consistently', () => {
    expect(calculateProfitability(input)).toEqual({
      revenue: 250,
      directCost: 120,
      totalCost: 140,
      profit: 110,
      margin: 44,
    })
  })

  it('represents a loss as revenue minus all direct and allocated costs', () => {
    expect(calculateProfitability({
      ...input,
      quantity: 2,
      sellingPrice: 50,
      costPerUnit: 100,
      additionalProductExpenses: 0,
      additionalCustomerExpenses: 0,
      sharedExpenses: 0,
    })).toEqual({
      revenue: 100,
      directCost: 200,
      totalCost: 200,
      profit: -100,
      margin: -100,
    })
  })

  it('supports fractional quantities and rejects unsafe or overflowing inputs', () => {
    expect(calculateProfitability({ ...input, quantity: 1.5 }).revenue).toBe(37.5)
    expect(() => calculateProfitability({
      ...input,
      quantity: Number.MAX_SAFE_INTEGER,
      sellingPrice: 2,
    })).toThrow(/too large to calculate safely/)
    expect(() => calculateProfitability({ ...input, costPerUnit: Number.POSITIVE_INFINITY }))
      .toThrow(/finite amounts/)
  })
})
