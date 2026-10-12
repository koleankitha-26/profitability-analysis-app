import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import type ExcelJS from 'exceljs'
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, Download, FileSpreadsheet, FileUp,
  LoaderCircle, Search, ShieldAlert, Upload, X,
} from 'lucide-react'
import { supabase, supabaseConfigMessage } from '../lib/supabase'
import { calculateProfitability, type Analysis, type AnalysisInput } from '../utils/profitability'

type UploadField = keyof AnalysisInput
type Mappings = Record<UploadField, number | null>
type ImportedRow = { id: string; sourceRow: number; cells: string[]; excluded: boolean }
type ImportResult = Analysis & { sourceRow: number; recommendation: string }
type SortField = 'productName' | 'revenue' | 'totalCost' | 'profit' | 'margin'
type SortDirection = 'asc' | 'desc'
type Validation = {
  values: Record<UploadField, string>
  errors: string[]
  warnings: string[]
  input: AnalysisInput | null
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const BATCH_SIZE = 100
const PREVIEW_PAGE_SIZE = 50
const UPLOAD_FIELDS: { key: UploadField; label: string; required: boolean; numeric: boolean; aliases: string[] }[] = [
  { key: 'productName', label: 'Product name', required: true, numeric: false, aliases: ['productname', 'product', 'productservice', 'service', 'item'] },
  { key: 'customerName', label: 'Customer name', required: false, numeric: false, aliases: ['customername', 'customer', 'clientname', 'client'] },
  { key: 'quantity', label: 'Quantity sold', required: true, numeric: true, aliases: ['quantitysold', 'quantity', 'unitsold', 'units'] },
  { key: 'sellingPrice', label: 'Selling price per unit', required: true, numeric: true, aliases: ['sellingpriceperunit', 'sellingprice', 'unitprice', 'priceperunit'] },
  { key: 'costPerUnit', label: 'Cost per unit', required: true, numeric: true, aliases: ['costperunit', 'unitcost', 'costpriceperunit'] },
  { key: 'additionalProductExpenses', label: 'Additional product expenses', required: false, numeric: true, aliases: ['additionalproductexpenses', 'productexpenses'] },
  { key: 'additionalCustomerExpenses', label: 'Additional customer expenses', required: false, numeric: true, aliases: ['additionalcustomerexpenses', 'customerexpenses'] },
  { key: 'sharedExpenses', label: 'Allocated shared expenses', required: false, numeric: true, aliases: ['allocatedsharedexpenses', 'sharedexpenses', 'allocatedexpenses'] },
]
const TEMPLATE_HEADERS = UPLOAD_FIELDS.map(({ label }) => label)
const EMPTY_MAPPINGS: Mappings = {
  productName: null, customerName: null, quantity: null, sellingPrice: null, costPerUnit: null,
  additionalProductExpenses: null, additionalCustomerExpenses: null, sharedExpenses: null,
}

function normalizeHeader(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
}

function cellText(value: ExcelJS.CellValue | undefined) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  if (value instanceof Date) return value.toISOString()
  if ('result' in value && value.result !== undefined) return String(value.result).trim()
  return String(value)
}

function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      row.push(field)
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
      field = ''
      if (character === '\r' && text[index + 1] === '\n') index += 1
    } else {
      field += character
    }
  }
  row.push(field)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  if (quoted) throw new Error('The CSV has an unfinished quoted field. Check the file and try again.')
  return rows
}

async function readRows(file: File): Promise<string[][]> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Choose a file smaller than 10 MB.')
  const extension = file.name.toLocaleLowerCase().split('.').pop()
  if (extension === 'csv') {
    const text = (await file.text()).replace(/^\uFEFF/, '')
    return parseCsv(text)
  }
  if (extension !== 'xlsx') throw new Error('Unsupported file type. Choose an .xlsx or .csv file.')
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await file.arrayBuffer())
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('The workbook does not contain a worksheet.')
  const rows: string[][] = []
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = []
    for (let column = 1; column <= row.cellCount; column += 1) cells.push(cellText(row.getCell(column).value))
    if (cells.some((value) => value.trim() !== '')) rows.push(cells)
  })
  return rows
}

function detectMappings(headers: string[]): Mappings {
  const usedColumns = new Set<number>()
  const mapping = { ...EMPTY_MAPPINGS }
  for (const field of UPLOAD_FIELDS) {
    const index = headers.findIndex((header, column) =>
      !usedColumns.has(column) && field.aliases.includes(normalizeHeader(header)))
    if (index !== -1) {
      mapping[field.key] = index
      usedColumns.add(index)
    }
  }
  return mapping
}

function validateRow(row: ImportedRow, headers: string[], mappings: Mappings, edits: Record<string, Partial<Record<UploadField, string>>>): Validation {
  const values = Object.fromEntries(UPLOAD_FIELDS.map(({ key }) => {
    const column = mappings[key]
    return [key, edits[row.id]?.[key] ?? (column === null ? '' : row.cells[column] ?? '')]
  })) as Record<UploadField, string>
  const errors: string[] = []
  const warnings: string[] = []
  for (const field of UPLOAD_FIELDS) {
    if (field.required && mappings[field.key] === null && !edits[row.id]?.[field.key]?.trim()) {
      errors.push(`Map a spreadsheet column to ${field.label}, or enter a value for this row.`)
    }
  }
  if (!values.productName.trim()) errors.push('Product name is required.')

  const parsed: Partial<Record<UploadField, string | number>> = {
    productName: values.productName.trim(),
    customerName: values.customerName.trim(),
  }
  let numericError = false
  for (const field of UPLOAD_FIELDS.filter(({ numeric }) => numeric)) {
    const rawValue = values[field.key].trim()
    const mapped = mappings[field.key] !== null
    const manuallyEntered = edits[row.id]?.[field.key] !== undefined
    if ((!mapped && !manuallyEntered) || rawValue === '') {
      if (field.required) {
        errors.push(`${field.label} is required; missing costs are not assumed to be zero.`)
        numericError = true
      } else if (mapped || rawValue === '') {
        parsed[field.key] = 0
        warnings.push(mapped
          ? `${field.label} is blank and will be treated as 0.`
          : `${field.label} is not mapped and will be treated as 0.`)
      }
      continue
    }
    const number = Number(rawValue)
    if (!Number.isFinite(number)) {
      errors.push(`${field.label} must be a valid number.`)
      numericError = true
    } else if (number < 0) {
      errors.push(`${field.label} cannot be negative.`)
      numericError = true
    } else if (field.key === 'quantity' && number === 0) {
      errors.push('Quantity sold must be greater than zero.')
      numericError = true
    } else {
      parsed[field.key] = number
    }
  }

  if (numericError || errors.length > 0) return { values, errors, warnings, input: null }
  const input: AnalysisInput = {
    productName: String(parsed.productName ?? ''),
    customerName: String(parsed.customerName ?? ''),
    quantity: Number(parsed.quantity),
    sellingPrice: Number(parsed.sellingPrice),
    costPerUnit: Number(parsed.costPerUnit),
    additionalProductExpenses: Number(parsed.additionalProductExpenses ?? 0),
    additionalCustomerExpenses: Number(parsed.additionalCustomerExpenses ?? 0),
    sharedExpenses: Number(parsed.sharedExpenses ?? 0),
  }
  const calculated = calculateProfitability(input)
  if (![calculated.revenue, calculated.directCost, calculated.totalCost, calculated.profit].every(Number.isFinite)
    || (calculated.margin !== null && !Number.isFinite(calculated.margin))) {
    errors.push('The selected values are too large to calculate safely.')
  }
  if (headers.length === 0) errors.push(`Spreadsheet row ${row.sourceRow} is missing its header mapping.`)
  return { values, errors, warnings, input: errors.length ? null : input }
}

function signature(input: AnalysisInput | null) {
  if (!input) return null
  return [input.productName.trim().toLocaleLowerCase(), input.customerName.trim().toLocaleLowerCase(),
    input.quantity, input.sellingPrice, input.costPerUnit, input.additionalProductExpenses,
    input.additionalCustomerExpenses, input.sharedExpenses].join('\u001f')
}

function recommendation(analysis: Analysis) {
  if (analysis.profit < 0) return 'Loss: review pricing and unit costs before repeating this sale.'
  if (analysis.margin !== null && analysis.margin < 10) return 'Low margin: consider a price increase or lower costs.'
  const extraExpenses = analysis.additionalProductExpenses + analysis.additionalCustomerExpenses + analysis.sharedExpenses
  if (analysis.revenue > 0 && extraExpenses / analysis.revenue > 0.25) return 'High additional expenses: review allocated and customer expenses.'
  return 'No immediate concern based on the uploaded values.'
}

function csvValue(value: string | number | null) {
  const text = value === null ? 'N/A' : String(value)
  const safeText = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safeText.replace(/"/g, '""')}"`
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function sums(rows: ImportResult[]) {
  return rows.reduce((total, row) => ({
    revenue: total.revenue + row.revenue,
    totalCost: total.totalCost + row.totalCost,
    profit: total.profit + row.profit,
  }), { revenue: 0, totalCost: 0, profit: 0 })
}

async function fileDigest(file: File) {
  const data = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export default function BulkUpload({ currency, onImported }: {
  currency: string
  onImported: (records: Analysis[]) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<ImportedRow[]>([])
  const [mappings, setMappings] = useState<Mappings>(EMPTY_MAPPINGS)
  const [edits, setEdits] = useState<Record<string, Partial<Record<UploadField, string>>>>({})
  const [fileName, setFileName] = useState('')
  const [sourceFingerprint, setSourceFingerprint] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [previewSearch, setPreviewSearch] = useState('')
  const [resultSearch, setResultSearch] = useState('')
  const [previewPage, setPreviewPage] = useState(0)
  const [sortField, setSortField] = useState<SortField>('profit')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [results, setResults] = useState<ImportResult[]>([])
  const [importState, setImportState] = useState<'idle' | 'importing' | 'saved' | 'partial' | 'failed'>('idle')
  const [progress, setProgress] = useState({ saved: 0, total: 0 })

  const validationById = useMemo(() => new Map(rows.map((row) => [
    row.id, validateRow(row, headers, mappings, edits),
  ])), [rows, headers, mappings, edits])

  const duplicateIds = useMemo(() => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const row of rows) {
      const validated = validationById.get(row.id)
      const key = signature(validated?.input ?? null)
      if (!key) continue
      if (seen.has(key)) duplicates.add(row.id)
      else seen.add(key)
    }
    return duplicates
  }, [rows, validationById])

  const includedRows = rows.filter((row) => !row.excluded)
  const invalidRows = includedRows.filter((row) => (validationById.get(row.id)?.errors.length ?? 0) > 0)
  const validRows = includedRows.filter((row) => validationById.get(row.id)?.input && !validationById.get(row.id)?.errors.length)
  const previewRows = rows.filter((row) => {
    const query = previewSearch.toLocaleLowerCase()
    if (!query) return true
    const validated = validationById.get(row.id)
    return String(row.sourceRow).includes(query)
      || validated?.values.productName.toLocaleLowerCase().includes(query)
      || validated?.values.customerName.toLocaleLowerCase().includes(query)
  })
  const previewPageCount = Math.ceil(previewRows.length / PREVIEW_PAGE_SIZE)
  const visiblePreviewRows = previewRows.slice(previewPage * PREVIEW_PAGE_SIZE, (previewPage + 1) * PREVIEW_PAGE_SIZE)
  const resultTotals = sums(results)
  const overallMargin = resultTotals.revenue === 0 ? null : resultTotals.profit / resultTotals.revenue * 100
  const invalidResultCount = rows.filter((row) => (validationById.get(row.id)?.errors.length ?? 0) > 0).length
  const excludedResultCount = rows.filter((row) => row.excluded).length
  const filteredResults = [...results].filter((row) => `${row.productName} ${row.customerName}`.toLocaleLowerCase().includes(resultSearch.toLocaleLowerCase()))
  filteredResults.sort((a, b) => {
    const first = a[sortField]
    const second = b[sortField]
    const firstValue = typeof first === 'number' ? first : sortDirection === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    const secondValue = typeof second === 'number' ? second : sortDirection === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    const compare = typeof first === 'string' && typeof second === 'string'
      ? first.localeCompare(second)
      : firstValue - secondValue
    return sortDirection === 'asc' ? compare : -compare
  })

  const reset = () => {
    setHeaders([])
    setRows([])
    setMappings(EMPTY_MAPPINGS)
    setEdits({})
    setFileName('')
    setSourceFingerprint('')
    setError('')
    setNotice('')
    setPreviewSearch('')
    setResultSearch('')
    setPreviewPage(0)
    setResults([])
    setImportState('idle')
    setProgress({ saved: 0, total: 0 })
    if (fileInput.current) fileInput.current.value = ''
  }

  const loadFile = async (file?: File) => {
    if (!file) return
    setError('')
    setNotice('')
    setResults([])
    setImportState('idle')
    setProgress({ saved: 0, total: 0 })
    try {
      if (!['csv', 'xlsx'].includes(file.name.toLocaleLowerCase().split('.').pop() ?? '')) {
        throw new Error('Unsupported file type. Choose an .xlsx or .csv file.')
      }
      const parsed = await readRows(file)
      if (parsed.length < 2) throw new Error('The file needs a header row and at least one data row.')
      const nextHeaders = parsed[0].map((header, index) => header.trim() || `Column ${index + 1}`)
      const nextMappings = detectMappings(nextHeaders)
      const nextRows = parsed.slice(1).map((cells, index): ImportedRow => ({
        id: crypto.randomUUID(),
        sourceRow: index + 2,
        cells,
        excluded: false,
      }))
      if (!nextRows.length) throw new Error('No data rows were found below the header.')
      setHeaders(nextHeaders)
      setMappings(nextMappings)
      setRows(nextRows)
      setFileName(file.name)
      setSourceFingerprint(await fileDigest(file))
      setEdits({})
      setPreviewPage(0)
    } catch (loadError: unknown) {
      const message = loadError instanceof Error ? loadError.message : 'The file could not be read.'
      setError(message)
      setHeaders([])
      setRows([])
      setFileName('')
      setSourceFingerprint('')
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void loadFile(event.currentTarget.files?.[0])
    event.currentTarget.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    void loadFile(event.dataTransfer.files[0])
  }

  const downloadTemplate = async (format: 'csv' | 'xlsx') => {
    if (format === 'csv') {
      downloadBlob(new Blob([`${TEMPLATE_HEADERS.map(csvValue).join(',')}\r\n`], { type: 'text/csv;charset=utf-8' }), 'profitability-upload-template.csv')
      return
    }
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Profitability')
    sheet.addRow(TEMPLATE_HEADERS)
    sheet.getRow(1).font = { bold: true }
    const bytes = await workbook.xlsx.writeBuffer()
    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'profitability-upload-template.xlsx')
  }

  const downloadWithFeedback = async (operation: () => Promise<void>, label: string) => {
    setError('')
    try {
      await operation()
    } catch (downloadError: unknown) {
      const message = downloadError instanceof Error ? downloadError.message : 'An unexpected error occurred.'
      setError(`Could not create the ${label} download: ${message}`)
    }
  }

  const updateMapping = (field: UploadField, value: string) => {
    setMappings((current) => ({ ...current, [field]: value === '' ? null : Number(value) }))
    setPreviewPage(0)
  }

  const updateRowValue = (rowId: string, field: UploadField, value: string) => {
    setEdits((current) => ({ ...current, [rowId]: { ...current[rowId], [field]: value } }))
  }

  const toggleExcluded = (rowId: string) => {
    setRows((current) => current.map((row) => row.id === rowId ? { ...row, excluded: !row.excluded } : row))
  }

  const startImport = async () => {
    if (importState === 'importing' || !sourceFingerprint) return
    if (invalidRows.length) {
      setError('Correct or exclude every invalid row before confirming the import.')
      return
    }
    if (!validRows.length) {
      setError('There are no valid, included rows to import.')
      return
    }
    const calculated = validRows.flatMap((row): ImportResult[] => {
      const input = validationById.get(row.id)?.input
      if (!input) return []
      const output = calculateProfitability(input)
      const record: Analysis = {
        ...input,
        ...output,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      }
      return [{ ...record, sourceRow: row.sourceRow, recommendation: recommendation(record) }]
    })
    setResults(calculated)
    setResultSearch('')
    setProgress({ saved: 0, total: calculated.length })
    setImportState('importing')
    setError('')
    setNotice('')
    let savedCount = 0

    if (!supabase) {
      setImportState('failed')
      setError(`${supabaseConfigMessage} The calculated preview is available, but these records were NOT saved.`)
      return
    }

    try {
      const { data, error: authError } = await supabase.auth.getUser()
      if (authError) throw new Error(`Could not verify the current Supabase user: ${authError.message}`)
      const user = data.user
      if (!user) {
        setImportState('failed')
        setError('No authenticated Supabase user was found. Sign in through the configured provider to save this import. The records were NOT saved.')
        return
      }

      const importedKey = `profitability-imports:${user.id}`
      let importedDigests: string[] = []
      try {
        const raw = localStorage.getItem(importedKey)
        importedDigests = raw ? JSON.parse(raw) as string[] : []
      } catch (storageError) {
        console.error('Could not read prior import fingerprints.', storageError)
      }
      if (importedDigests.includes(sourceFingerprint)) {
        setImportState('failed')
        setError('This exact file was already imported in this browser for the current account. No rows were sent again.')
        return
      }

      const records = calculated.map((record) => ({
        user_id: user.id,
        product_name: record.productName,
        customer_name: record.customerName,
        quantity_sold: record.quantity,
        selling_price: record.sellingPrice,
        cost_per_unit: record.costPerUnit,
        additional_product_expenses: record.additionalProductExpenses,
        additional_customer_expenses: record.additionalCustomerExpenses,
        allocated_shared_expenses: record.sharedExpenses,
        created_at: record.createdAt,
      }))
      for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
        const batch = records.slice(offset, offset + BATCH_SIZE)
        const { error: databaseError } = await supabase
          .from('analyses')
          .insert(batch)
        if (databaseError) {
          throw new Error(`Database rejected batch ${Math.floor(offset / BATCH_SIZE) + 1}: ${databaseError.message}`)
        }
        const batchResults = calculated.slice(offset, offset + batch.length)
        onImported(batchResults.map((record) => {
          const { sourceRow: _sourceRow, recommendation: _recommendation, ...analysis } = record
          return analysis
        }))
        savedCount += batch.length
        setProgress({ saved: savedCount, total: records.length })
      }
      try {
        localStorage.setItem(importedKey, JSON.stringify([...importedDigests, sourceFingerprint]))
      } catch (storageError) {
        console.error('Could not save import fingerprint.', storageError)
        setNotice('Import succeeded, but this browser could not record the local duplicate-import reminder.')
      }
      setImportState('saved')
      setNotice((current) => current || `Successfully saved ${savedCount} record${savedCount === 1 ? '' : 's'} to your account.`)
    } catch (importError: unknown) {
      const message = importError instanceof Error ? importError.message : 'An unexpected import error occurred.'
      setImportState(savedCount > 0 ? 'partial' : 'failed')
      setError(savedCount > 0
        ? `${message} ${savedCount} record${savedCount === 1 ? ' was' : 's were'} confirmed saved; the remaining rows were not confirmed. Check the saved rows before uploading again to avoid duplicates.`
        : `${message} No records were confirmed as saved. Check that the existing analyses table has the required columns and that its Row Level Security policies allow this user to insert.`)
    }
  }

  const downloadResults = async (format: 'csv' | 'xlsx') => {
    const outputHeaders = [
      'Product name', 'Customer name', 'Quantity sold', 'Selling price per unit', 'Cost per unit',
      'Additional product expenses', 'Additional customer expenses', 'Allocated shared expenses',
      'Revenue', 'Direct cost', 'Total cost', 'Profit / loss', 'Profit margin', 'Recommendation',
    ]
    const values = filteredResults.map((row) => [
      row.productName, row.customerName, row.quantity, row.sellingPrice, row.costPerUnit,
      row.additionalProductExpenses, row.additionalCustomerExpenses, row.sharedExpenses,
      row.revenue, row.directCost, row.totalCost, row.profit, row.margin, row.recommendation,
    ])
    if (format === 'csv') {
      const csv = [outputHeaders, ...values].map((row) => row.map((value) => csvValue(typeof value === 'number' ? (Number.isFinite(value) ? value : null) : value)).join(',')).join('\r\n')
      downloadBlob(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }), 'profitability-results.csv')
      return
    }
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Results')
    sheet.addRow(outputHeaders)
    values.forEach((row) => sheet.addRow(row))
    sheet.getRow(1).font = { bold: true }
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    const bytes = await workbook.xlsx.writeBuffer()
    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'profitability-results.xlsx')
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortField(field)
      setSortDirection(field === 'productName' ? 'asc' : 'desc')
    }
  }

  return (
    <div className="bulk-upload-page">
      <div className="page-heading">
        <div><div className="eyebrow">Data tools</div><h1>Bulk data upload</h1><p>Validate, calculate, and save multiple profitability analyses at once.</p></div>
      </div>

      {!rows.length && !results.length && <>
        <section className="card bulk-instructions">
          <div className="bulk-instructions-heading"><FileSpreadsheet /><div><h2 className="card-title">Prepare your spreadsheet</h2><p className="card-subtitle">Upload Excel (.xlsx) or CSV (.csv), up to 10 MB. Your file is read in this browser.</p></div></div>
          <ol>
            <li>Use one row per product sale and include the required product, quantity, selling price, and unit cost columns.</li>
            <li>Customer name and additional expenses are optional. Blank expense cells are explicitly warned and treated as zero.</li>
            <li>Check the column mapping and correct or exclude invalid rows before confirming. Nothing is saved until you confirm.</li>
          </ol>
          <p className="bulk-database-note">Saving requires a configured Supabase project, a currently authenticated user, and an existing <code>analyses</code> table with matching columns and Row Level Security permissions. This app does not create or alter database tables.</p>
          <div className="bulk-template-actions">
            <button className="btn btn-outline" type="button" onClick={() => void downloadWithFeedback(() => downloadTemplate('csv'), 'CSV template')}><Download />Download CSV template</button>
            <button className="btn btn-outline" type="button" onClick={() => void downloadWithFeedback(() => downloadTemplate('xlsx'), 'Excel template')}><Download />Download Excel template</button>
          </div>
        </section>
        <div className={`bulk-dropzone${dragOver ? ' drag-over' : ''}`} role="button" tabIndex={0}
          aria-label="Choose or drop an Excel or CSV file"
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.current?.click() } }}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}>
          <span className="bulk-drop-icon"><FileUp /></span>
          <strong>Drop your file here, or browse</strong>
          <span>Excel workbook (.xlsx) or comma-separated values (.csv)</span>
          <button type="button" className="btn btn-primary" onClick={(event) => { event.stopPropagation(); fileInput.current?.click() }}><Upload />Choose file</button>
          <input ref={fileInput} type="file" accept=".xlsx,.csv" className="visually-hidden" onChange={handleFileChange} />
        </div>
        {error && <div className="alert" role="alert">{error}</div>}
      </>}

      {!!rows.length && !results.length && <>
        <div className="bulk-file-banner">
          <div><FileSpreadsheet /><span><strong>{fileName}</strong><small>{rows.length.toLocaleString()} data rows · {headers.length} columns</small></span></div>
          <button type="button" className="btn btn-outline" onClick={reset}><X />Choose another file</button>
        </div>
        <section className="card bulk-mapping">
          <div className="bulk-section-heading"><div><h2 className="card-title">Map spreadsheet columns</h2><p className="card-subtitle">We matched familiar headers automatically. Confirm or change any field mapping.</p></div></div>
          <div className="bulk-mapping-grid">{UPLOAD_FIELDS.map((field) => (
            <label className="field" key={field.key}>
              <span>{field.label}{field.required && <b> *</b>}</span>
              <select value={mappings[field.key] === null ? '' : String(mappings[field.key])} onChange={(event) => updateMapping(field.key, event.target.value)}>
                <option value="">{field.required ? 'Choose a column' : 'Not provided'}</option>
                {headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header}</option>)}
              </select>
            </label>
          ))}</div>
        </section>
        <div className="bulk-summary-strip">
          <div><span>Rows uploaded</span><strong>{rows.length.toLocaleString()}</strong></div>
          <div><span>Valid rows</span><strong className="profit-text">{validRows.length.toLocaleString()}</strong></div>
          <div><span>Invalid rows</span><strong className={invalidRows.length ? 'loss-text' : ''}>{invalidRows.length.toLocaleString()}</strong></div>
          <div><span>Excluded rows</span><strong>{rows.length - includedRows.length}</strong></div>
        </div>
        {error && <div className="alert" role="alert">{error}</div>}
        <section className="card bulk-preview">
          <div className="bulk-section-heading bulk-preview-heading">
            <div><h2 className="card-title">Review rows</h2><p className="card-subtitle">Correct values directly in the table or exclude rows you do not want to import.</p></div>
            <label className="bulk-search"><Search /><input aria-label="Search upload preview" value={previewSearch} onChange={(event) => { setPreviewSearch(event.target.value); setPreviewPage(0) }} placeholder="Search row, product or customer" /></label>
          </div>
          <div className="table-scroll"><table className="bulk-preview-table">
            <thead><tr><th>Row</th><th>Product name *</th><th>Customer</th><th>Quantity *</th><th>Selling price *</th><th>Cost / unit *</th><th>Product expenses</th><th>Customer expenses</th><th>Shared expenses</th><th>Validation</th><th>Include</th></tr></thead>
            <tbody>{visiblePreviewRows.map((row) => {
              const validation = validationById.get(row.id) ?? validateRow(row, headers, mappings, edits)
              const warnings = [...validation.warnings]
              if (duplicateIds.has(row.id)) warnings.push('Duplicate of another row; review before import.')
              return <tr key={row.id} className={row.excluded ? 'row-excluded' : ''}>
                <td>{row.sourceRow}</td>
                {UPLOAD_FIELDS.map((field) => <td key={field.key}>
                  <input className="bulk-cell-input" aria-label={`Row ${row.sourceRow}: ${field.label}`}
                    aria-invalid={validation.errors.some((message) => message.toLocaleLowerCase().includes(field.label.toLocaleLowerCase()))}
                    value={validation.values[field.key]}
                    onChange={(event) => updateRowValue(row.id, field.key, event.target.value)}
                    placeholder={field.required ? 'Required' : field.numeric ? '0' : 'Optional'}
                    inputMode={field.numeric ? 'decimal' : 'text'} />
                </td>)}
                <td className="bulk-validation-cell">
                  {validation.errors.length > 0
                    ? <span className="bulk-row-error" title={validation.errors.join(' ')}><ShieldAlert />{validation.errors.join(' ')}</span>
                    : warnings.length > 0
                      ? <span className="bulk-row-warning" title={warnings.join(' ')}><AlertTriangle />{warnings.join(' ')}</span>
                      : <span className="bulk-row-valid"><Check />Ready</span>}
                </td>
                <td><button type="button" className={`bulk-include-toggle${row.excluded ? ' excluded' : ''}`}
                  aria-pressed={!row.excluded} onClick={() => toggleExcluded(row.id)}>{row.excluded ? 'Excluded' : 'Include'}</button></td>
              </tr>
            })}</tbody>
          </table></div>
          {!visiblePreviewRows.length && <p className="bulk-empty-search">No upload rows match this search.</p>}
          {previewPageCount > 1 && <div className="bulk-pagination">
            <span>Showing {previewPage * PREVIEW_PAGE_SIZE + 1}–{Math.min((previewPage + 1) * PREVIEW_PAGE_SIZE, previewRows.length)} of {previewRows.length.toLocaleString()} rows</span>
            <div><button type="button" className="btn btn-outline" disabled={previewPage === 0} onClick={() => setPreviewPage((page) => page - 1)}>Previous</button>
              <button type="button" className="btn btn-outline" disabled={previewPage >= previewPageCount - 1} onClick={() => setPreviewPage((page) => page + 1)}>Next</button></div>
          </div>}
        </section>
        <div className="bulk-confirm-row">
          <span>{invalidRows.length ? 'Correct or exclude all invalid rows to continue.' : `${validRows.length.toLocaleString()} valid row${validRows.length === 1 ? '' : 's'} ready. No data will be saved before you confirm.`}</span>
          <button className="btn btn-primary" type="button" disabled={invalidRows.length > 0 || !validRows.length}
            onClick={() => void startImport()}><Check />Confirm and import {validRows.length.toLocaleString()} rows</button>
        </div>
      </>}

      {results.length > 0 && <>
        <div className="bulk-summary-strip results-summary">
          <div><span>Total rows uploaded</span><strong>{rows.length.toLocaleString()}</strong></div>
          <div><span>Valid rows processed</span><strong className="profit-text">{results.length.toLocaleString()}</strong></div>
          <div><span>Invalid rows</span><strong className={invalidResultCount ? 'loss-text' : ''}>{invalidResultCount.toLocaleString()}</strong></div>
          <div><span>Excluded rows</span><strong>{excludedResultCount.toLocaleString()}</strong></div>
          <div><span>Total revenue</span><strong>{money(resultTotals.revenue, currency)}</strong></div>
          <div><span>Total cost</span><strong>{money(resultTotals.totalCost, currency)}</strong></div>
          <div><span>Total profit / loss</span><strong className={resultTotals.profit >= 0 ? 'profit-text' : 'loss-text'}>{money(resultTotals.profit, currency)}</strong></div>
          <div><span>Overall margin</span><strong>{overallMargin === null ? 'N/A' : `${overallMargin.toFixed(1)}%`}</strong></div>
        </div>
        <div className={`bulk-save-state ${importState}`}>
          {importState === 'importing' ? <LoaderCircle className="bulk-spinner" /> : importState === 'saved' ? <Check /> : <AlertTriangle />}
          <div><strong>{importState === 'importing' ? 'Saving import' : importState === 'saved' ? 'Import saved' : importState === 'partial' ? 'Import partially saved' : 'Import not saved'}</strong>
            <p>{importState === 'importing'
              ? `Saved ${progress.saved.toLocaleString()} of ${progress.total.toLocaleString()} rows in batches.`
              : notice || error}</p>
            {importState === 'importing' && <progress value={progress.saved} max={progress.total} aria-label="Import progress" />}
          </div>
        </div>
        {error && <div className="alert" role="alert">{error}</div>}
        {notice && importState === 'saved' && <p className="bulk-save-notice">{notice}</p>}
        <section className="card bulk-results">
          <div className="bulk-section-heading bulk-preview-heading">
            <div><h2 className="card-title">Product-level results</h2><p className="card-subtitle">Calculated using the existing profitability formula.</p></div>
            <div className="bulk-result-actions">
              <label className="bulk-search"><Search /><input aria-label="Search calculated results" value={resultSearch} onChange={(event) => setResultSearch(event.target.value)} placeholder="Search products" /></label>
              <button type="button" className="btn btn-outline" onClick={() => void downloadWithFeedback(() => downloadResults('csv'), 'CSV results')}><Download />CSV</button>
              <button type="button" className="btn btn-outline" onClick={() => void downloadWithFeedback(() => downloadResults('xlsx'), 'Excel results')}><Download />Excel</button>
            </div>
          </div>
          <div className="table-scroll"><table className="bulk-results-table">
            <thead><tr><th><button type="button" className="bulk-sort" onClick={() => toggleSort('productName')}>Product / customer
              {sortField === 'productName' && (sortDirection === 'asc' ? <ArrowUp /> : <ArrowDown />)}</button></th><th>Quantity</th>
              {(['revenue', 'totalCost', 'profit', 'margin'] as SortField[]).map((field) => (
                <th key={field}><button type="button" className="bulk-sort" onClick={() => toggleSort(field)}>
                  {field === 'totalCost' ? 'Total cost' : field === 'profit' ? 'Profit / loss' : field === 'margin' ? 'Margin' : 'Revenue'}
                  {sortField === field && (sortDirection === 'asc' ? <ArrowUp /> : <ArrowDown />)}
                </button></th>
              ))}<th>Recommendation</th></tr></thead>
            <tbody>{filteredResults.map((row) => <tr key={row.id}>
              <td><strong>{row.productName}</strong><small>{row.customerName || 'No customer'} · spreadsheet row {row.sourceRow}</small></td>
              <td>{row.quantity}</td><td>{money(row.revenue, currency)}</td><td>{money(row.totalCost, currency)}</td>
              <td className={row.profit >= 0 ? 'profit-text' : 'loss-text'}>{money(row.profit, currency)}</td>
              <td>{row.margin === null ? 'N/A' : `${row.margin.toFixed(1)}%`}</td>
              <td className={row.profit < 0 || (row.margin !== null && row.margin < 10) ? 'bulk-recommendation warn' : 'bulk-recommendation'}>{row.recommendation}</td>
            </tr>)}</tbody>
          </table></div>
          {!filteredResults.length && <p className="bulk-empty-search">No calculated results match this search.</p>}
        </section>
        <div className="bulk-confirm-row">
          <span>Results are available for export. The local analysis history was updated only for batches confirmed by Supabase.</span>
          <div className="bulk-result-actions">
            {importState === 'failed' && <button className="btn btn-primary" type="button"
              onClick={() => void startImport()}><Check />Retry import</button>}
            <button className="btn btn-outline" type="button" onClick={reset}><FileUp />Upload another file</button>
          </div>
        </div>
      </>}
    </div>
  )
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}
