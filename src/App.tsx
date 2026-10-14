import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react'
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, BriefcaseBusiness, CalendarDays,
  Check, ChevronRight, CircleDollarSign, FileBarChart, FilePlus2, FileSpreadsheet, Lightbulb,
  LogOut, Menu, Moon, Package, Plus, Settings2, Sun, Trash2, TrendingUp, Upload,
  UserPlus, UserRound, Wallet,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { User } from '@supabase/supabase-js'
import { supabase, supabaseConfigMessage } from './lib/supabase'
import {
  ANALYSIS_COLUMNS, analysesForUser, analysisContentSignature, analysisFromSupabase, analysisSignature,
  reconcileLocalAnalyses, saveAnalysisIdempotently,
} from './lib/analyses'
import {
  clearAnalysisDraft, loadAnalysisDraft, saveAnalysisDraft,
  type AnalysisDraft,
} from './lib/analysisDraft'
import { calculateProfitability, type Analysis, type AnalysisInput } from './utils/profitability'
import BulkUpload from './components/BulkUpload'
import ProfilePhotoEditor, { CIRCULAR_CROP_MIN_ZOOM } from './components/ProfilePhotoEditor'

type Profile = {
  fullName: string
  email: string
  businessName: string
  businessType: string
  currency: string
  jobTitle?: string
  phoneNumber?: string
  businessWebsite?: string
  businessLocation?: string
  businessDescription?: string
  avatar?: string
}

type Settings = { darkMode: boolean }
type GoogleIdentity = { fullName: string; email: string }
type SupabaseProfile = {
  id: string
  full_name: string | null
  business_name: string | null
  business_type: string | null
  currency: string | null
}
type Page = 'dashboard' | 'new' | 'results' | 'history' | 'reports' | 'bulk' | 'settings'
type FormValues = AnalysisDraft
type FieldErrors = Partial<Record<keyof FormValues, string>>

const NAV_ITEMS: { id: Page; label: string; icon: typeof Activity }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'new', label: 'New analysis', icon: FilePlus2 },
  { id: 'history', label: 'Analysis history', icon: BarChart3 },
  { id: 'reports', label: 'Reports', icon: FileBarChart },
  { id: 'bulk', label: 'Bulk upload', icon: FileSpreadsheet },
  { id: 'settings', label: 'Profile & settings', icon: BriefcaseBusiness },
]
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'SGD']
const BUSINESS_TYPES = ['Retail', 'E-commerce', 'Professional services', 'Manufacturing', 'Food & beverage', 'Other']
const AVATAR_CHOICES = [
  { id: 'initials-mint', label: 'Mint initials', background: '#315c50' },
  { id: 'initials-blue', label: 'Blue initials', background: '#36547a' },
  { id: 'initials-rose', label: 'Rose initials', background: '#704653' },
  { id: 'cartoon-cat', label: 'Cat cartoon', background: '#e7dfcd', face: '🐱' },
  { id: 'cartoon-fox', label: 'Fox cartoon', background: '#f2e1ca', face: '🦊' },
  { id: 'cartoon-owl', label: 'Owl cartoon', background: '#e6e0f1', face: '🦉' },
  { id: 'cartoon-bear', label: 'Bear cartoon', background: '#eadbd2', face: '🐻' },
]
const MIN_SIDEBAR_WIDTH = 212
const MAX_SIDEBAR_WIDTH = 340
const EMPTY_FORM: FormValues = {
  productName: '', quantity: '', sellingPrice: '', costPerUnit: '', customerName: '',
  additionalProductExpenses: '0', additionalCustomerExpenses: '0', sharedExpenses: '0',
}

function ProfileAvatar({ profile, className = 'avatar' }: { profile: Profile; className?: string }) {
  const choice = AVATAR_CHOICES.find(({ id }) => id === profile.avatar)
  if (profile.avatar?.startsWith('data:image/')) {
    return <span className={className}><img src={profile.avatar} alt="" /></span>
  }
  return (
    <span className={className} style={choice ? { background: choice.background } : undefined} aria-hidden="true">
      {choice?.face ?? initials(profile.fullName)}
    </span>
  )
}

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch (error) {
    console.error(`Could not read local data for "${key}".`, error)
    return fallback
  }
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}

function compactMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1,
    }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString()}`
  }
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'U'
}

function metadataFullName(user: User) {
  const metadata = user.user_metadata
  const givenAndFamilyName = [metadata.given_name, metadata.family_name]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ')
  return [metadata.full_name, metadata.name, givenAndFamilyName]
    .find((value) => typeof value === 'string' && value.trim())
}

function getGoogleIdentity(user: User): GoogleIdentity | null {
  const providers = [
    user.app_metadata.provider,
    ...(Array.isArray(user.app_metadata.providers) ? user.app_metadata.providers : []),
    ...(user.identities ?? []).map((identity) => identity.provider),
  ]
  if (!providers.includes('google')) return null

  const fullName = metadataFullName(user)
  return {
    fullName: typeof fullName === 'string' ? fullName.trim() : '',
    email: user.email ?? '',
  }
}

function profileFromRow(row: SupabaseProfile, user: User): Profile {
  const metadataName = metadataFullName(user)
  return {
    fullName: row.full_name?.trim()
      || (typeof metadataName === 'string' ? metadataName.trim() : '')
      || user.email?.split('@')[0]
      || '',
    email: user.email ?? '',
    businessName: row.business_name ?? '',
    businessType: row.business_type ?? '',
    currency: row.currency || 'USD',
  }
}

async function getOrCreateSupabaseProfile(user: User): Promise<Profile> {
  if (!supabase) throw new Error(supabaseConfigMessage)

  const columns = 'id, full_name, business_name, business_type, currency'
  const { data: existing, error: selectError } = await supabase
    .from('profiles')
    .select(columns)
    .eq('id', user.id)
    .maybeSingle()

  if (selectError) throw new Error(`Could not load your profile from Supabase: ${selectError.message}`)
  if (existing) return profileFromRow(existing, user)

  const metadataName = metadataFullName(user)
  const fullName = typeof metadataName === 'string'
    ? metadataName.trim()
    : user.email?.split('@')[0] ?? ''
  const { data: created, error: insertError } = await supabase
    .from('profiles')
    .insert({
      id: user.id,
      full_name: fullName,
      business_name: '',
      business_type: '',
      currency: 'USD',
    })
    .select(columns)
    .single()

  if (!insertError && created) return profileFromRow(created, user)

  if (insertError?.code === '23505') {
    const { data: racedProfile, error: racedSelectError } = await supabase
      .from('profiles')
      .select(columns)
      .eq('id', user.id)
      .maybeSingle()
    if (!racedSelectError && racedProfile) return profileFromRow(racedProfile, user)
    if (racedSelectError) {
      throw new Error(`Could not load your profile after a concurrent sign-in: ${racedSelectError.message}`)
    }
  }

  throw new Error(`Could not create your Supabase profile: ${insertError?.message ?? 'No profile row was returned.'}`)
}

function App() {
  const [isLoggedOut, setIsLoggedOut] = useState(() => loadStored('profitability-logged-out', false))
  const [profile, setProfile] = useState<Profile | null>(() => loadStored('profitability-profile', null))
  const [analyses, setAnalyses] = useState<Analysis[]>(() => loadStored('profitability-analyses', []))
  const [settings, setSettings] = useState<Settings>(() => loadStored('profitability-settings', { darkMode: false }))
  const [googleIdentity, setGoogleIdentity] = useState<GoogleIdentity | null>(null)
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authResolved, setAuthResolved] = useState(!supabase)
  const [profileLoading, setProfileLoading] = useState(Boolean(supabase))
  const [profileLoadAttempt, setProfileLoadAttempt] = useState(0)
  const [analysisLoading, setAnalysisLoading] = useState(Boolean(supabase))
  const [retryingAnalyses, setRetryingAnalyses] = useState(false)
  const [analysisLoadError, setAnalysisLoadError] = useState('')
  const [remoteAnalysisSignatures, setRemoteAnalysisSignatures] = useState<Set<string>>(() => new Set())
  const [browserOnlyAnalysisIds, setBrowserOnlyAnalysisIds] = useState<Set<string>>(() => new Set())
  const [authError, setAuthError] = useState('')
  const [page, setPage] = useState<Page>('dashboard')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, loadStored('profitability-sidebar-width', 252))))
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [storageWarning, setStorageWarning] = useState('')
  const authUserId = authUser?.id
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const resizingSidebarRef = useRef(false)
  const hiddenLocalAnalysesRef = useRef<Analysis[]>([])
  const visibleAnalyses = authUserId
    ? analysesForUser(analyses, authUserId)
    : analyses
  const selectedAnalysis = visibleAnalyses.find((item) => item.id === selectedId) ?? null

  useEffect(() => {
    if (!supabase) return

    let active = true
    const callbackParams = new URLSearchParams(window.location.search)
    const callbackHashParams = new URLSearchParams(window.location.hash.slice(1))
    const callbackError = callbackParams.get('error_description')
      ?? callbackParams.get('error')
      ?? callbackHashParams.get('error_description')
      ?? callbackHashParams.get('error')
    if (callbackError) setAuthError(`Google sign-in failed: ${callbackError}`)

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      if (session?.user) {
        setAuthUser(session.user)
        setGoogleIdentity(getGoogleIdentity(session.user))
        setProfileLoading(true)
        setAuthResolved(true)
        setAuthError('')
      } else {
        setAuthUser(null)
        setGoogleIdentity(null)
        setProfileLoading(false)
        setAnalysisLoading(false)
        setAuthResolved(true)
      }
    })

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) {
        setAuthError(`Could not check your Supabase session: ${error.message}`)
        setAnalysisLoading(false)
      } else if (data.session?.user) {
        setAuthUser(data.session.user)
        setGoogleIdentity(getGoogleIdentity(data.session.user))
        setProfileLoading(true)
      } else {
        setProfileLoading(false)
        setAnalysisLoading(false)
      }
      setAuthResolved(true)
    }).catch((error: unknown) => {
      if (!active) return
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
      setAuthError(`Could not check your Supabase session: ${message}`)
      setProfileLoading(false)
      setAnalysisLoading(false)
      setAuthResolved(true)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !authUser) return

    let active = true
    void getOrCreateSupabaseProfile(authUser).then((loadedProfile) => {
      if (!active) return
      setProfile(loadedProfile)
      setIsLoggedOut(false)
      setAuthError('')
    }).catch((error: unknown) => {
      if (!active) return
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
      setProfile(null)
      setAuthError(message)
    }).finally(() => {
      if (active) setProfileLoading(false)
    })

    return () => {
      active = false
    }
  }, [authUser, profileLoadAttempt])

  useEffect(() => {
    if (!supabase || !authUserId) {
      setRemoteAnalysisSignatures(new Set())
      setAnalysisLoadError('')
      setAnalysisLoading(false)
      if (!authUserId) {
        hiddenLocalAnalysesRef.current = []
        const localAnalyses = loadStored<Analysis[]>('profitability-analyses', [])
        setAnalyses(localAnalyses)
        setBrowserOnlyAnalysisIds(new Set(
          localAnalyses.filter((analysis) => analysis.syncStatus !== 'synced').map((analysis) => analysis.id),
        ))
      }
      return
    }

    let active = true
    setAnalysisLoading(true)
    setAnalysisLoadError('')

    void (async () => {
      try {
        const remoteRows = []
        const pageSize = 1000
        for (let offset = 0; ; offset += pageSize) {
          const { data, error } = await supabase
            .from('analyses')
            .select(ANALYSIS_COLUMNS)
            .eq('user_id', authUserId)
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1)

          if (!active) return
          if (error) throw new Error(error.message)
          if ((data ?? []).some((row) => row.user_id !== authUserId)) {
            throw new Error('Supabase returned an analysis row that does not belong to the signed-in user.')
          }
          remoteRows.push(...(data ?? []))
          if (!data || data.length < pageSize) break
        }

        const remoteAnalyses = remoteRows.map((row) => analysisFromSupabase(row))
        const remoteSignatures = new Set(remoteAnalyses.map(analysisSignature))
        const localAnalyses = loadStored<Analysis[]>('profitability-analyses', [])
        const ownedLocal = localAnalyses.filter((analysis) => analysis.syncUserId === authUserId)
        const unassignedLocal = localAnalyses.filter((analysis) => !analysis.syncUserId)
        const browserOnlyAnalyses = reconcileLocalAnalyses(ownedLocal, remoteAnalyses)
        const unassignedPending = reconcileLocalAnalyses(unassignedLocal, remoteAnalyses)
        const visibleIds = new Set([
          ...remoteAnalyses.map((analysis) => analysis.id),
          ...browserOnlyAnalyses.map((analysis) => analysis.id),
        ])
        hiddenLocalAnalysesRef.current = localAnalyses.filter((analysis) => !visibleIds.has(analysis.id))

        setRemoteAnalysisSignatures(remoteSignatures)
        setBrowserOnlyAnalysisIds(new Set([
          ...browserOnlyAnalyses,
          ...unassignedPending,
        ].map((analysis) => analysis.id)))
        setAnalyses([...remoteAnalyses, ...browserOnlyAnalyses].sort(
          (first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt),
        ))
      } catch (error: unknown) {
        if (!active) return
        const message = error instanceof Error ? error.message : 'An unexpected database error occurred.'
        setAnalysisLoadError(`Could not load analysis history from Supabase: ${message}`)
        const localAnalyses = loadStored<Analysis[]>('profitability-analyses', [])
        const visibleLocal = localAnalyses.filter(
          (analysis) => !analysis.syncUserId || analysis.syncUserId === authUserId,
        )
        hiddenLocalAnalysesRef.current = localAnalyses.filter(
          (analysis) => analysis.syncUserId && analysis.syncUserId !== authUserId,
        )
        setAnalyses(visibleLocal)
        setBrowserOnlyAnalysisIds(new Set(
          visibleLocal.filter((analysis) => analysis.syncStatus !== 'synced').map((analysis) => analysis.id),
        ))
      } finally {
        if (active) setAnalysisLoading(false)
      }
    })()

    return () => {
      active = false
    }
  }, [authUserId])

  useEffect(() => {
    try {
      if (!authUser) {
        if (profile) localStorage.setItem('profitability-profile', JSON.stringify(profile))
        else if (!isLoggedOut) localStorage.removeItem('profitability-profile')
      }
      localStorage.setItem('profitability-logged-out', JSON.stringify(isLoggedOut))
      const storedById = new Map(
        hiddenLocalAnalysesRef.current.map((analysis) => [analysis.id, analysis]),
      )
      analyses.forEach((analysis) => storedById.set(analysis.id, analysis))
      localStorage.setItem('profitability-analyses', JSON.stringify([...storedById.values()]))
      localStorage.setItem('profitability-settings', JSON.stringify(settings))
      setStorageWarning('')
    } catch (error) {
      console.error('Could not save app data to localStorage.', error)
      setStorageWarning('Your browser could not save changes locally. Check available storage and browser privacy settings.')
    }
  }, [profile, isLoggedOut, analyses, settings, authUser])

  useEffect(() => {
    try {
      localStorage.setItem('profitability-sidebar-width', String(sidebarWidth))
    } catch (error) {
      console.error('Could not save sidebar width to localStorage.', error)
    }
  }, [sidebarWidth])

  useEffect(() => {
    if (!profileMenuOpen) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [profileMenuOpen])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const goTo = (target: Page) => {
    setPage(target)
    setMobileOpen(false)
    setProfileMenuOpen(false)
  }

  const startSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizingSidebarRef.current = true
  }

  const moveSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizingSidebarRef.current) {
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX)))
    }
  }

  const stopSidebarResize = () => {
    resizingSidebarRef.current = false
  }

  const addAccount = async () => {
    setProfileMenuOpen(false)
    if (!supabase) {
      setToast({ text: supabaseConfigMessage, error: true })
      return
    }
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
      if (error) setToast({ text: `Could not start account sign-in: ${error.message}`, error: true })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
      setToast({ text: `Could not start account sign-in: ${message}`, error: true })
    }
  }

  const logOut = async () => {
    setProfileMenuOpen(false)
    try {
      if (supabase) {
        const { data, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) throw sessionError
        if (data.session) {
          const { error } = await supabase.auth.signOut()
          if (error) throw error
        }
      }

      setIsLoggedOut(true)
      setGoogleIdentity(null)
      setPage('dashboard')
      setSelectedId(null)
      setToast({ text: 'You are signed out. Your saved profile, analyses, and settings remain in this browser.' })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
      setToast({ text: `Could not log out: ${message}`, error: true })
    }
  }

  const saveProfile = async (updated: Profile) => {
    if (authUser && supabase) {
      const { data, error } = await supabase
        .from('profiles')
        .update({
          full_name: updated.fullName.trim(),
          business_name: updated.businessName.trim(),
          business_type: updated.businessType,
          currency: updated.currency,
        })
        .eq('id', authUser.id)
        .select('id, full_name, business_name, business_type, currency')
        .single()

      if (error) throw new Error(`Could not save your profile to Supabase: ${error.message}`)
      if (!data) throw new Error('Could not save your profile to Supabase: no profile row was returned.')

      setProfile({
        ...updated,
        ...profileFromRow(data, authUser),
        jobTitle: updated.jobTitle,
        phoneNumber: updated.phoneNumber,
        businessWebsite: updated.businessWebsite,
        businessLocation: updated.businessLocation,
        businessDescription: updated.businessDescription,
        avatar: updated.avatar,
      })
    } else {
      setProfile(updated)
    }
    setToast({ text: 'Profile and business details updated.' })
  }

  const openAnalysis = (analysis: Analysis) => {
    setSelectedId(analysis.id)
    goTo('results')
  }

  const deleteAnalysis = async (id: string) => {
    const target = analyses.find((item) => item.id === id)
    if (!target) return
    const signature = analysisSignature(target)
    const isRemoteAnalysis = !browserOnlyAnalysisIds.has(target.id) && remoteAnalysisSignatures.has(signature)
    const confirmationMessage = isRemoteAnalysis
      ? `Delete the analysis for "${target.productName}" from your Supabase account? This cannot be undone.`
      : `Remove the browser-only analysis for "${target.productName}"? It has not been saved to Supabase.`
    if (!window.confirm(confirmationMessage)) return

    if (isRemoteAnalysis && authUser && supabase) {
      try {
        const { data, error } = await supabase
          .from('analyses')
          .delete()
          .eq('id', target.id)
          .eq('user_id', authUser.id)
          .select('id')
          .maybeSingle()

        if (error) {
          setToast({ text: `Could not delete this analysis from Supabase: ${error.message}`, error: true })
          return
        }
        if (!data) {
          setToast({ text: 'Supabase did not confirm deleting this analysis. It remains in your history.', error: true })
          return
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'An unexpected database error occurred.'
        setToast({ text: `Could not delete this analysis from Supabase: ${message}`, error: true })
        return
      }
    }

    setAnalyses((current) => current.filter((item) => item.id !== id))
    setBrowserOnlyAnalysisIds((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
    if (isRemoteAnalysis) {
      setRemoteAnalysisSignatures((current) => {
        const stillPresent = analyses.some((item) => item.id !== id && analysisSignature(item) === signature)
        if (stillPresent) return current
        const next = new Set(current)
        next.delete(signature)
        return next
      })
    }
    if (selectedId === id) {
      setSelectedId(null)
      goTo('history')
    }
    setToast({ text: isRemoteAnalysis ? 'Analysis deleted from Supabase.' : 'Browser-only analysis removed.' })
  }

  const retryPendingAnalyses = async () => {
    if (!supabase || !authUser) {
      setToast({ text: 'Sign in before retrying browser-only analyses.', error: true })
      return
    }

    const pendingById = new Map<string, Analysis>()
    for (const analysis of [
      ...loadStored<Analysis[]>('profitability-analyses', []),
      ...hiddenLocalAnalysesRef.current,
      ...analyses,
    ]) {
      if (browserOnlyAnalysisIds.has(analysis.id)) pendingById.set(analysis.id, analysis)
    }
    const pending = [...pendingById.values()]
    if (!pending.length) return

    const legacyCount = pending.filter((analysis) => !analysis.syncUserId).length
    const unassignedPending = pending.filter((analysis) => !analysis.syncUserId)
    const message = legacyCount
      ? `${pending.length - legacyCount} record(s) are associated with this account. ${legacyCount} legacy record(s) have no saved owner and will be checked against Supabase, but will not be uploaded without your confirmation.`
      : `Retry saving ${pending.length} browser-only analysis record(s) associated with this account?`
    if (!window.confirm(message)) return

    setRetryingAnalyses(true)
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw new Error(`Could not verify the current Supabase user: ${userError.message}`)
      if (!user || user.id !== authUser.id) {
        throw new Error('The current Supabase session does not match the displayed account. Sign in again before retrying.')
      }

      const remoteRows: Array<{
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
      }> = []
      const pageSize = 1000
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from('analyses')
          .select(ANALYSIS_COLUMNS)
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .range(offset, offset + pageSize - 1)
        if (error) throw new Error(`Could not check existing analyses before retrying: ${error.message}`)
        remoteRows.push(...(data ?? []))
        if (!data || data.length < pageSize) break
      }
      const remoteAnalyses = remoteRows.map((row) => analysisFromSupabase(row))
      const confirmed = new Map<string, Analysis>()
      const failures: string[] = []

      for (const localRecord of pending) {
        if (localRecord.syncUserId && localRecord.syncUserId !== user.id) {
          failures.push(`${localRecord.productName}: saved for a different account`)
          continue
        }

        const existingById = remoteAnalyses.find((record) => record.id === localRecord.id)
        if (existingById) {
          if (analysisContentSignature(existingById) !== analysisContentSignature(localRecord)) {
            failures.push(`${localRecord.productName}: this ID already exists with different data`)
            continue
          }
          confirmed.set(localRecord.id, existingById)
          continue
        }

        const equivalentRemote = remoteAnalyses.filter((record) =>
          analysisContentSignature(record) === analysisContentSignature(localRecord))
        if (equivalentRemote.length) {
          failures.push(`${localRecord.productName}: matching data already exists under another ID; not uploaded to avoid a duplicate`)
          continue
        }

        if (!localRecord.syncUserId && !window.confirm(
          `The legacy browser-only analysis "${localRecord.productName}" was not found in your Supabase account. Confirm that it belongs to this account and save it now?`,
        )) {
          failures.push(`${localRecord.productName}: not uploaded because ownership was not confirmed`)
          continue
        }

        try {
          const { data: { user: currentUser }, error: currentUserError } = await supabase.auth.getUser()
          if (currentUserError) throw new Error(`Could not recheck the session: ${currentUserError.message}`)
          if (!currentUser || currentUser.id !== user.id) {
            throw new Error('The signed-in account changed during recovery.')
          }
          const savedRow = await saveAnalysisIdempotently(
            supabase,
            localRecord,
            user.id,
            localRecord.id,
            localRecord.createdAt,
          )
          confirmed.set(localRecord.id, analysisFromSupabase(savedRow))
        } catch (error: unknown) {
          failures.push(`${localRecord.productName}: ${error instanceof Error ? error.message : 'save was not confirmed'}`)
        }
      }

      const claimedRecords = unassignedPending.filter((analysis) => confirmed.has(analysis.id))
      claimedRecords.forEach((analysis) => { analysis.syncUserId = user.id })
      if (claimedRecords.length) {
        const claimedIds = new Set(claimedRecords.map((analysis) => analysis.id))
        hiddenLocalAnalysesRef.current = hiddenLocalAnalysesRef.current.filter(
          (analysis) => !claimedIds.has(analysis.id),
        )
        setAnalyses((current) => {
          const ids = new Set(current.map((analysis) => analysis.id))
          return [...current, ...claimedRecords.filter((analysis) => !ids.has(analysis.id))]
        })
        try {
          const localRecords = loadStored<Analysis[]>('profitability-analyses', [])
          localStorage.setItem('profitability-analyses', JSON.stringify(
            localRecords.map((analysis) => claimedIds.has(analysis.id)
              ? { ...analysis, syncUserId: user.id }
              : analysis),
          ))
        } catch (error) {
          console.error('Could not persist the claimed analysis ownership.', error)
          setStorageWarning('These browser-only records are assigned to this account for this session, but their ownership could not be saved locally.')
        }
      }

      if (confirmed.size) {
        const synced = [...confirmed.values()]
        setAnalyses((current) => {
          const syncedById = new Map(synced.map((analysis) => [analysis.id, analysis]))
          return current.map((analysis) => syncedById.get(analysis.id) ?? analysis)
        })
        setBrowserOnlyAnalysisIds((current) => {
          const next = new Set(current)
          confirmed.forEach((_, id) => next.delete(id))
          return next
        })
        setRemoteAnalysisSignatures((current) => {
          const next = new Set(current)
          synced.forEach((analysis) => next.add(analysisSignature(analysis)))
          return next
        })
      }
      setToast(failures.length
        ? { text: `${confirmed.size} record(s) confirmed in Supabase. ${failures.length} remain browser-only: ${failures.join('; ')}`, error: true }
        : { text: `${confirmed.size} pending record(s) confirmed in Supabase.` })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unexpected recovery error occurred.'
      setToast({ text: `Pending analyses were preserved; recovery failed: ${message}`, error: true })
    } finally {
      setRetryingAnalyses(false)
    }
  }

  const clearAll = () => {
    const message = authUser
      ? 'Clear browser-only analyses and local settings? Supabase analyses and your profile will not be deleted.'
      : 'Clear all saved analyses, profile details, and settings from this browser? This action cannot be undone.'
    if (!window.confirm(message)) return
    if (!authUser) setProfile(null)
    setIsLoggedOut(false)
    setAnalyses((current) => authUser
      ? current.filter((item) => remoteAnalysisSignatures.has(analysisSignature(item)))
      : [])
    if (authUser) setBrowserOnlyAnalysisIds(new Set())
    setSettings({ darkMode: false })
    setSelectedId(null)
    setPage('dashboard')
    setToast({ text: authUser
      ? 'Browser-only analyses and local settings have been cleared. Your Supabase analyses and profile are unchanged.'
      : 'All locally saved data has been cleared.' })
  }

  const currency = profile?.currency ?? 'USD'
  if (!authResolved || (authUser && (profileLoading || analysisLoading))) {
    return <div className="welcome-screen"><div className="welcome-card"><section className="welcome-main">
      <h2>Loading your profile</h2><p role="status">Checking your Supabase session and profile…</p>
    </section></div></div>
  }

  if (authUser && !profile) {
    return <div className="welcome-screen"><div className="welcome-card"><section className="welcome-main">
      <h2>Could not load your Supabase profile</h2>
      <p className="alert" role="alert">{authError || 'Your profile could not be loaded or created.'}</p>
      <p>Check that your profiles table allows this signed-in user to select, insert, and update only their own row, then retry.</p>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => {
          setAuthError('')
          setProfileLoading(true)
          setProfileLoadAttempt((attempt) => attempt + 1)
        }}>Retry</button>
        <button className="btn btn-outline" onClick={() => void logOut()}>Sign out</button>
      </div>
    </section></div></div>
  }

  if (!profile || isLoggedOut) {
    return (
      <>
        <WelcomeScreen googleIdentity={googleIdentity} authError={authError} savedProfile={profile}
          onRestore={() => {
            setIsLoggedOut(false)
            setToast({ text: 'Your saved local profile has been restored.' })
          }}
          onCreate={(newProfile) => {
            setProfile(newProfile)
            setIsLoggedOut(false)
            setToast({ text: 'Your profile is ready. Start by creating your first analysis.' })
          }} />
        {toast && <div className="toast">{toast.text}</div>}
        {storageWarning && <div className="toast error">{storageWarning}</div>}
      </>
    )
  }

  return (
    <div className={`app-shell${settings.darkMode ? ' dark-mode' : ''}`}>
      <div className={`sidebar-overlay${mobileOpen ? ' visible' : ''}`} onClick={() => setMobileOpen(false)} />
      <button className="mobile-sidebar-trigger" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu /></button>
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}
        style={{ width: collapsed ? 82 : sidebarWidth }}>
        <div className="sidebar-top">
          <button className="sidebar-menu-button" aria-label={mobileOpen ? 'Close navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={mobileOpen ? 'Close navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => {
              if (window.matchMedia('(max-width: 760px)').matches) setMobileOpen(false)
              else setCollapsed((value) => !value)
            }}><Menu /></button>
          <div className="brand" aria-label="Profitability Analysis">
            <div className="brand-mark"><TrendingUp /></div>
            <span className="brand-name">Profitability</span>
          </div>
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="nav-list" aria-label="Main navigation">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button className={`nav-item${page === id || (id === 'history' && page === 'results') ? ' active' : ''}`}
              key={id} onClick={() => goTo(id)} title={collapsed ? label : undefined}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-menu-wrap" ref={profileMenuRef}>
            {profileMenuOpen && <div className="profile-menu" role="menu" aria-label="Profile menu">
              <button role="menuitem" onClick={() => goTo('settings')}><UserRound />View profile</button>
              <button role="menuitem" onClick={() => goTo('settings')}><Settings2 />Profile settings</button>
              <button role="menuitem" onClick={() => void addAccount()}><UserPlus />Add account</button>
              <button role="menuitem" onClick={() => void logOut()}><LogOut />Log out</button>
            </div>}
            <button className="user-chip" title={collapsed ? profile.fullName : undefined}
              aria-haspopup="menu" aria-expanded={profileMenuOpen}
              aria-label={`Profile menu for ${profile.fullName}`} onClick={() => setProfileMenuOpen((open) => !open)}>
              <ProfileAvatar profile={profile} />
              <span className="user-chip-copy"><strong>{profile.fullName}</strong><small>{profile.businessName}</small></span>
            </button>
          </div>
        </div>
        {!collapsed && <div className="sidebar-resize-handle" role="separator" aria-orientation="vertical"
          aria-label="Resize sidebar" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize} onPointerUp={stopSidebarResize} onPointerCancel={stopSidebarResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              setSidebarWidth((width) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width + (event.key === 'ArrowRight' ? 10 : -10))))
            }
          }} />}
      </aside>
      <main className={`main-area${collapsed ? ' expanded' : ''}`} style={{ marginLeft: collapsed ? 82 : sidebarWidth }}>
        <header className="topbar">
          <div className="topbar-left">
            <div className="breadcrumb">Workspace <ChevronRight size={13} /> <strong>{pageTitle(page)}</strong></div>
          </div>
          <div className="topbar-right">
            <div className="top-date"><CalendarDays />{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</div>
            <button className="icon-button" aria-label={settings.darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={() => setSettings((current) => ({ ...current, darkMode: !current.darkMode }))}>
              {settings.darkMode ? <Sun /> : <Moon />}
            </button>
          </div>
        </header>
        <div className="page-content">
          {storageWarning && <div className="alert" role="alert">{storageWarning}</div>}
          {analysisLoadError && <div className="alert" role="alert">{analysisLoadError} Browser-only records remain available in this browser.</div>}
          {!analysisLoading && browserOnlyAnalysisIds.size > 0 &&
            <div className="alert" role="status">
              {browserOnlyAnalysisIds.size} local analysis record(s) are not yet confirmed in Supabase.
              {authUser
                ? <> They are being preserved in this browser. <button className="btn-link" onClick={() => void retryPendingAnalyses()} disabled={retryingAnalyses}>
                    {retryingAnalyses ? 'Checking and retrying…' : 'Review and retry'}
                  </button></>
                : ' They remain in this browser; sign in to verify or recover them.'}
            </div>}
          {page === 'dashboard' && <Dashboard analyses={visibleAnalyses} currency={currency} localOnlyIds={browserOnlyAnalysisIds} onNew={() => goTo('new')} onView={openAnalysis} />}
          {page === 'new' && <NewAnalysis currency={currency} onCancel={() => goTo('dashboard')} onSave={async (input) => {
            const calculated = calculateProfitability(input)
            const createdAt = new Date().toISOString()
            let record: Analysis = {
              ...input,
              ...calculated,
              id: crypto.randomUUID(),
              createdAt,
              syncStatus: 'pending',
              ...(authUserId ? { syncUserId: authUserId } : {}),
            }
            setAnalyses((current) => current.some((item) => item.id === record.id) ? current : [record, ...current])
            setBrowserOnlyAnalysisIds((current) => new Set(current).add(record.id))
            let savedLocally = false
            try {
              const stored = loadStored<Analysis[]>('profitability-analyses', analyses)
              if (!stored.some((item) => item.id === record.id)) {
                localStorage.setItem('profitability-analyses', JSON.stringify([record, ...stored]))
              }
              savedLocally = true
            } catch (error) {
              console.error('Could not preserve the pending analysis in localStorage.', error)
              setStorageWarning('This analysis could not be safely stored in this browser. Keep this page open and retry; do not close it until it is saved.')
            }
            if (supabase) {
              const { data: { session }, error: sessionError } = await supabase.auth.getSession()
              if (sessionError) {
                setToast({ text: `Analysis is preserved in this browser but was not confirmed in Supabase: ${sessionError.message}`, error: true })
                return false
              }

              let databaseUser: User | null = null
              if (session) {
                const { data: { user }, error: userError } = await supabase.auth.getUser()
                if (userError) {
                  setToast({ text: `Analysis is preserved in this browser but the Supabase user could not be verified: ${userError.message}`, error: true })
                  return false
                }
                if (!user || user.id !== session.user.id) {
                  setToast({ text: 'Analysis is preserved in this browser but the Supabase user could not be verified. Please sign in again and retry.', error: true })
                  return false
                }
                databaseUser = user
              } else if (authUser) {
                setToast({ text: 'Your session has expired. The analysis is preserved in this browser; sign in again and use Review and retry.', error: true })
                return false
              }

              if (databaseUser) {
                record.syncUserId = databaseUser.id
                try {
                  const stored = loadStored<Analysis[]>('profitability-analyses', analyses)
                  localStorage.setItem('profitability-analyses', JSON.stringify(
                    stored.map((item) => item.id === record.id ? record : item),
                  ))
                } catch (error) {
                  console.error('Could not persist the pending analysis owner.', error)
                  setStorageWarning('The pending analysis is still in memory, but its account ownership could not be saved locally.')
                }
                try {
                  const savedRow = await saveAnalysisIdempotently(
                    supabase,
                    input,
                    databaseUser.id,
                    record.id,
                    record.createdAt,
                  )
                  record = analysisFromSupabase(savedRow)
                  setAnalyses((current) => current.map((item) => item.id === record.id ? record : item))
                  setBrowserOnlyAnalysisIds((current) => {
                    const next = new Set(current)
                    next.delete(record.id)
                    return next
                  })
                  setRemoteAnalysisSignatures((current) => new Set(current).add(analysisSignature(record)))
                  setToast({ text: 'Analysis confirmed in your Supabase account.' })
                  if (!clearAnalysisDraft(sessionStorage)) {
                    setToast({ text: 'Analysis was saved, but the form draft could not be cleared from this tab.', error: true })
                  }
                  setSelectedId(record.id)
                  setPage('results')
                  return true
                } catch (error: unknown) {
                  const message = error instanceof Error ? error.message : 'An unexpected database error occurred.'
                  setToast({ text: `Analysis is preserved in this browser but was not confirmed in Supabase: ${message} Use Review and retry after checking your connection.`, error: true })
                  return false
                }
              } else {
                setToast({ text: 'Analysis saved in this browser only; sign in and use Review and retry to save it to Supabase.', error: true })
                if (savedLocally) {
                  if (!clearAnalysisDraft(sessionStorage)) {
                    setToast({ text: 'Analysis was saved in this browser, but the form draft could not be cleared from this tab.', error: true })
                  }
                  setSelectedId(record.id)
                  setPage('results')
                }
                return savedLocally
              }
            } else {
              setToast({ text: 'Analysis is browser-only because Supabase is not configured. It remains pending for recovery after sign-in.', error: true })
              if (savedLocally) {
                if (!clearAnalysisDraft(sessionStorage)) {
                  setToast({ text: 'Analysis was saved in this browser, but the form draft could not be cleared from this tab.', error: true })
                }
                setSelectedId(record.id)
                setPage('results')
              }
              return savedLocally
            }
          }} />}
          {page === 'results' && selectedAnalysis && <Results analysis={selectedAnalysis} currency={currency} onHistory={() => goTo('history')} onNew={() => goTo('new')} />}
          {page === 'results' && !selectedAnalysis && <MissingResult onHistory={() => goTo('history')} />}
          {page === 'history' && <History analyses={visibleAnalyses} currency={currency} localOnlyIds={browserOnlyAnalysisIds} onView={openAnalysis} onDelete={deleteAnalysis} onNew={() => goTo('new')} />}
          {page === 'reports' && <Reports analyses={visibleAnalyses} currency={currency} />}
          {page === 'bulk' && <BulkUpload currency={currency} onImported={(records) => {
            setRemoteAnalysisSignatures((current) => {
              const next = new Set(current)
              records.forEach((record) => next.add(analysisSignature(record)))
              return next
            })
            setBrowserOnlyAnalysisIds((current) => {
              if (!current.size) return current
              const importedIds = new Set(records.map((record) => record.id))
              return new Set([...current].filter((id) => !importedIds.has(id)))
            })
            setAnalyses((current) => {
              const currentIds = new Set(current.map((record) => record.id))
              return [...records.filter((record) => !currentIds.has(record.id)), ...current]
            })
          }} />}
          {page === 'settings' && <SettingsPage profile={profile} darkMode={settings.darkMode} emailReadOnly={Boolean(authUser)}
            onSave={saveProfile}
            onAvatarSave={(avatar) => {
              setProfile((current) => current ? { ...current, avatar } : current)
              setToast({ text: 'Profile photo saved.' })
            }}
            onToggleTheme={() => setSettings((current) => ({ ...current, darkMode: !current.darkMode }))}
            onClear={clearAll} />}
        </div>
      </main>
      {toast && <div className={`toast${toast.error ? ' error' : ''}`} role="status">{toast.text}</div>}
    </div>
  )
}

function pageTitle(page: Page) {
  return NAV_ITEMS.find((item) => item.id === page)?.label ?? 'Analysis results'
}

function WelcomeScreen({ googleIdentity, authError, savedProfile, onRestore, onCreate }: {
  googleIdentity: GoogleIdentity | null
  authError: string
  savedProfile: Profile | null
  onRestore: () => void
  onCreate: (profile: Profile) => void
}) {
  const [error, setError] = useState('')
  const [googleSetupMessage, setGoogleSetupMessage] = useState('')
  const [password, setPassword] = useState('')
  const [values, setValues] = useState<Profile>({
    fullName: googleIdentity?.fullName ?? '',
    email: googleIdentity?.email ?? '',
    businessName: '',
    businessType: '',
    currency: 'USD',
  })
  useEffect(() => {
    if (!googleIdentity) return
    setValues((current) => ({
      ...current,
      fullName: current.fullName || googleIdentity.fullName,
      email: current.email || googleIdentity.email,
    }))
  }, [googleIdentity])

  const signInWithGoogle = async () => {
    setGoogleSetupMessage('')
    if (!supabase) {
      setGoogleSetupMessage(supabaseConfigMessage)
      return
    }
    try {
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
      if (signInError) setError(`Google sign-in could not start: ${signInError.message}`)
    } catch (signInError: unknown) {
      const message = signInError instanceof Error ? signInError.message : 'An unexpected error occurred.'
      setError(`Google sign-in could not start: ${message}`)
    }
  }

  const update = (key: keyof Profile, value: string) => setValues((current) => ({ ...current, [key]: value }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!values.fullName.trim() || !values.email.trim() || !values.businessName.trim() || !values.businessType || (!googleIdentity && !password)) {
      setError('Complete all fields to create your profile.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      setError('Enter a valid email address.')
      return
    }
    setError('')
    setPassword('')
    onCreate({ ...values, fullName: values.fullName.trim(), email: values.email.trim(), businessName: values.businessName.trim() })
  }
  return (
    <div className="welcome-screen">
      <div className="welcome-card">
        <aside className="welcome-aside">
          <div className="brand"><div className="brand-mark"><TrendingUp /></div><span className="brand-name">Profitability</span></div>
          <h1>Make every sale count.</h1>
          <p>Understand what is driving your margins, keep your analysis organized, and make more confident business decisions.</p>
        </aside>
        <section className="welcome-main">
          <h2>Create your profile</h2>
          <p>Set up your workspace. Your business information stays in this browser.</p>
          {error && <div className="alert" role="alert">{error}</div>}
          {authError && <div className="alert" role="alert">{authError}</div>}
          {googleIdentity && <p className="oauth-setup-message" role="status">Signed in with Google as {googleIdentity.email}. Complete your business details to create your local profile.</p>}
          {savedProfile && !googleIdentity && <div className="saved-profile">
            <p>Saved local profile: <strong>{savedProfile.fullName}</strong> ({savedProfile.email})</p>
            <p>This profile is stored in this browser and is not a signed-in account.</p>
            <button className="btn btn-primary" type="button" onClick={onRestore}>Continue with saved profile <ChevronRight /></button>
          </div>}
          <form onSubmit={submit}>
            <div className="field-grid">
              <Field label="Full name" required><input autoComplete="name" value={values.fullName} onChange={(e) => update('fullName', e.target.value)} placeholder="e.g. Alex Morgan" /></Field>
              <Field label="Email address" required><input type="email" autoComplete="email" value={values.email} onChange={(e) => update('email', e.target.value)} placeholder="you@business.com" /></Field>
              <Field label="Business name" required><input value={values.businessName} onChange={(e) => update('businessName', e.target.value)} placeholder="Your business" /></Field>
              <Field label="Business type" required><select value={values.businessType} onChange={(e) => update('businessType', e.target.value)}><option value="">Select type</option>{BUSINESS_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field>
              <Field label="Preferred currency" required><select value={values.currency} onChange={(e) => update('currency', e.target.value)}>{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select></Field>
              {!googleIdentity && <Field label="Demo password" required><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter any value" /><small className="demo-password-note">Demo-only field; it is never saved or used for authentication.</small></Field>}
            </div>
            <p className="privacy-copy">Your profile, settings, and analyses are stored locally in your browser. Google sign-in uses Supabase when configured; no password-based account is created.</p>
            <button className="btn btn-primary" type="submit">Create profile <ChevronRight /></button>
            <div className="oauth-divider" aria-hidden="true"><span>or</span></div>
            <button className="btn btn-google" type="button" onClick={() => void signInWithGoogle()}>
              <svg className="google-icon" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z" />
                <path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z" />
                <path fill="#FBBC05" d="M12.6 27.7a12 12 0 0 1 0-7.4V15H5.8a20 20 0 0 0 0 18l6.8-5.3Z" />
                <path fill="#EA4335" d="M24 11.9c3 0 5.6 1 7.7 3l5.8-5.8C34 5.8 29.4 4 24 4A20 20 0 0 0 5.8 15l6.8 5.3c1.6-4.8 6.1-8.4 11.4-8.4Z" />
              </svg>
              Continue with Google
            </button>
            {googleSetupMessage && <p className="oauth-setup-message" role="status">{googleSetupMessage}</p>}
          </form>
        </section>
      </div>
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <div className="field"><label>{label}{required && <span> *</span>}</label>{children}</div>
}

function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{subtitle}</p></div>{action}</div>
}

function MetricCard({ label, value, foot, icon: Icon, mood }: { label: string; value: string; foot: string; icon: typeof Wallet; mood?: 'good' | 'bad' }) {
  return <div className="card metric-card">
    <div className="metric-top"><span>{label}</span><div className="metric-icon"><Icon /></div></div>
    <div className="metric-value">{value}</div><div className={`metric-foot${mood ? ` ${mood}` : ''}`}>{foot}</div>
  </div>
}

function Dashboard({ analyses, currency, localOnlyIds, onNew, onView }: {
  analyses: Analysis[]; currency: string; localOnlyIds: ReadonlySet<string>
  onNew: () => void; onView: (analysis: Analysis) => void
}) {
  const totals = totalsFor(analyses)
  const averageMargin = totals.revenue === 0 ? null : (totals.profit / totals.revenue) * 100
  const data = chartData(analyses.slice(0, 7).reverse(), currency)
  return <>
    <PageHeading eyebrow="Overview" title="Good to see you" subtitle="Here's how your business is performing so far."
      action={<button className="btn btn-primary" onClick={onNew}><Plus />New analysis</button>} />
    <div className="metric-grid">
      <MetricCard label="Total revenue" value={money(totals.revenue, currency)} foot="Across saved analyses" icon={CircleDollarSign} />
      <MetricCard label="Total cost" value={money(totals.cost, currency)} foot="Direct and allocated expenses" icon={Wallet} />
      <MetricCard label="Total profit / loss" value={money(totals.profit, currency)} foot={analyses.length ? (totals.profit >= 0 ? 'Your saved analyses are profitable' : 'Your saved analyses are at a loss') : 'No saved data yet'} icon={totals.profit >= 0 ? ArrowUpRight : ArrowDownRight} mood={analyses.length ? (totals.profit >= 0 ? 'good' : 'bad') : undefined} />
      <MetricCard label="Overall profit margin" value={averageMargin === null ? 'N/A' : `${averageMargin.toFixed(1)}%`} foot="Weighted by total revenue" icon={TrendingUp} />
    </div>
    <div className="charts-grid">
      <div className="card chart-card">
        <div className="card-title-row"><div><h2 className="card-title">Revenue vs. cost</h2><p className="card-subtitle">Based on your saved analyses</p></div><div className="legend"><span className="legend-item"><i className="legend-dot" />Revenue</span><span className="legend-item"><i className="legend-dot cost" />Cost</span></div></div>
        <RevenueCostChart data={data} currency={currency} />
      </div>
      <div className="card chart-card">
        <div className="card-title-row"><div><h2 className="card-title">Profit trend</h2><p className="card-subtitle">Profit / loss by saved analysis</p></div></div>
        <ProfitTrendChart data={data} currency={currency} />
      </div>
    </div>
    <div className="card section-card">
      <div className="section-header"><div><h2 className="card-title">Recent analyses</h2><p className="card-subtitle">Your latest saved profitability calculations</p></div><button className="btn-link" onClick={() => onNew()}>+ New analysis</button></div>
      {analyses.length === 0 ? <div className="table-empty"><Package /><strong>Your dashboard is ready when you are</strong><p>Create your first analysis to see revenue, costs, and trends here.</p><button className="btn btn-primary" onClick={onNew}><Plus />Create first analysis</button></div> :
        <AnalysisTable analyses={analyses.slice(0, 5)} currency={currency} localOnlyIds={localOnlyIds} onView={onView} />}
    </div>
  </>
}

function chartData(items: Analysis[], currency: string) {
  return items.map((item, index) => ({
    ...item, label: items.length > 1 ? `#${items.length - index}` : shortDate(item.createdAt),
    title: item.productName, revLabel: compactMoney(item.revenue, currency),
  }))
}

function ChartEmpty() {
  return <div className="empty-chart"><div className="empty-chart-inner"><BarChart3 /><div>No analysis data yet</div><small>Your saved calculations will appear here</small></div></div>
}

function RevenueCostChart({ data, currency }: { data: ReturnType<typeof chartData>; currency: string }) {
  if (!data.length) return <div className="chart-wrap"><ChartEmpty /></div>
  return <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%">
    <BarChart data={data} margin={{ top: 10, right: 4, left: -14, bottom: 0 }} barGap={4}>
      <CartesianGrid stroke="#eef1f3" strokeDasharray="3 4" vertical={false} />
      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#9aa4af', fontSize: 9 }} />
      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#9aa4af', fontSize: 9 }} tickFormatter={(value: number) => compactMoney(value, currency)} />
      <Tooltip formatter={(value) => money(Number(value ?? 0), currency)} labelFormatter={(_, entries) => entries[0]?.payload?.title ?? ''} contentStyle={{ border: '1px solid #e8ecef', borderRadius: 8, fontSize: 11 }} />
      <Bar dataKey="revenue" name="Revenue" fill="#5b9e87" radius={[4, 4, 0, 0]} maxBarSize={28} />
      <Bar dataKey="totalCost" name="Cost" fill="#c8d8d3" radius={[4, 4, 0, 0]} maxBarSize={28} />
    </BarChart>
  </ResponsiveContainer></div>
}

function ProfitTrendChart({ data, currency }: { data: ReturnType<typeof chartData>; currency: string }) {
  if (!data.length) return <div className="chart-wrap"><ChartEmpty /></div>
  return <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%">
    <LineChart data={data} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
      <CartesianGrid stroke="#eef1f3" strokeDasharray="3 4" vertical={false} />
      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#9aa4af', fontSize: 9 }} />
      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#9aa4af', fontSize: 9 }} tickFormatter={(value: number) => compactMoney(value, currency)} />
      <Tooltip formatter={(value) => money(Number(value ?? 0), currency)} labelFormatter={(_, entries) => entries[0]?.payload?.title ?? ''} contentStyle={{ border: '1px solid #e8ecef', borderRadius: 8, fontSize: 11 }} />
      <Line type="monotone" dataKey="profit" name="Profit / loss" stroke="#428a70" strokeWidth={2.5} dot={{ r: 3, fill: '#428a70', strokeWidth: 0 }} activeDot={{ r: 5 }} />
    </LineChart>
  </ResponsiveContainer></div>
}

function totalsFor(analyses: Analysis[]) {
  return analyses.reduce((totals, item) => ({
    revenue: totals.revenue + item.revenue, cost: totals.cost + item.totalCost, profit: totals.profit + item.profit,
  }), { revenue: 0, cost: 0, profit: 0 })
}

function AnalysisTable({ analyses, currency, localOnlyIds, onView, onDelete }: {
  analyses: Analysis[]; currency: string; onView: (analysis: Analysis) => void; onDelete?: (id: string) => void
  localOnlyIds?: ReadonlySet<string>
}) {
  return <div className="table-scroll"><table>
    <thead><tr><th>Date</th><th>Product</th><th>Customer</th><th>Revenue</th><th>Total cost</th><th>Profit / loss</th><th>Margin</th><th>Status</th><th /></tr></thead>
    <tbody>{analyses.map((item) => <tr key={item.id}>
      <td>{shortDate(item.createdAt)}</td><td><strong>{item.productName}</strong>{localOnlyIds?.has(item.id) && <small className="analysis-local-only">Browser only</small>}</td><td>{item.customerName || '—'}</td>
      <td>{money(item.revenue, currency)}</td><td>{money(item.totalCost, currency)}</td>
      <td className={item.profit >= 0 ? 'profit-text' : 'loss-text'}>{money(item.profit, currency)}</td>
      <td>{item.margin === null ? 'N/A' : `${item.margin.toFixed(1)}%`}</td>
      <td><span className={`status-pill${item.profit < 0 ? ' loss' : ''}`}>{item.profit >= 0 ? 'Profitable' : 'Loss'}</span></td>
      <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><button className="btn-link" onClick={() => onView(item)}>View</button>{onDelete && <button className="btn-link" style={{ color: '#b9534e' }} aria-label={`Delete ${item.productName}`} onClick={() => onDelete(item.id)}><Trash2 size={14} /></button>}</div></td>
    </tr>)}</tbody>
  </table></div>
}

function NewAnalysis({ currency, onSave, onCancel }: {
  currency: string; onSave: (input: AnalysisInput) => Promise<boolean>; onCancel: () => void
}) {
  const [values, setValues] = useState<FormValues>(() => {
    try {
      return loadAnalysisDraft(sessionStorage) ?? EMPTY_FORM
    } catch (error) {
      console.error('Could not restore the analysis draft.', error)
      return EMPTY_FORM
    }
  })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (key: keyof FormValues, value: string) => {
    const next = { ...values, [key]: value }
    setValues(next)
    try {
      saveAnalysisDraft(sessionStorage, next)
      setFormError('')
    } catch (error) {
      console.error('Could not save the analysis draft.', error)
      setFormError('Your changes could not be saved for later in this tab. Keep this page open until they are saved.')
    }
  }
  const validate = () => {
    const next: FieldErrors = {}
    if (!values.productName.trim()) next.productName = 'Enter a product or service name.'
    if (!values.quantity || !Number.isFinite(Number(values.quantity)) || Number(values.quantity) <= 0) next.quantity = 'Quantity must be a positive finite value within the safe calculation range.'
    for (const key of ['sellingPrice', 'costPerUnit', 'additionalProductExpenses', 'additionalCustomerExpenses', 'sharedExpenses'] as const) {
      const raw = values[key]
      if (raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) next[key] = 'Enter a valid amount of zero or more.'
    }
    if (!Object.keys(next).length) {
      try {
        calculateProfitability({
          productName: values.productName.trim(),
          customerName: values.customerName.trim(),
          quantity: Number(values.quantity),
          sellingPrice: Number(values.sellingPrice),
          costPerUnit: Number(values.costPerUnit),
          additionalProductExpenses: Number(values.additionalProductExpenses),
          additionalCustomerExpenses: Number(values.additionalCustomerExpenses),
          sharedExpenses: Number(values.sharedExpenses),
        })
      } catch (error: unknown) {
        next.quantity = error instanceof Error ? error.message : 'These values cannot be calculated safely.'
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFormError('')
    if (!validate()) {
      setFormError('Please review the highlighted fields before calculating.')
      return
    }
    setSaving(true)
    try {
      const saved = await onSave({
      productName: values.productName.trim(), customerName: values.customerName.trim(),
      quantity: Number(values.quantity), sellingPrice: Number(values.sellingPrice),
      costPerUnit: Number(values.costPerUnit), additionalProductExpenses: Number(values.additionalProductExpenses),
      additionalCustomerExpenses: Number(values.additionalCustomerExpenses), sharedExpenses: Number(values.sharedExpenses),
      })
      if (!saved) {
        setFormError('The analysis was not confirmed as saved. Your draft has been kept so you can retry.')
        return
      }
      if (!clearAnalysisDraft(sessionStorage)) {
        setFormError('Analysis saved, but this tab could not clear the saved draft.')
      }
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : 'Could not save this analysis.')
    } finally {
      setSaving(false)
    }
  }
  const clear = () => {
    if (!window.confirm('Reset all entered analysis details and clear this saved draft?')) return
    if (!clearAnalysisDraft(sessionStorage)) {
      setFormError('The draft could not be cleared from this tab. Your entered values were kept.')
      return
    }
    setValues(EMPTY_FORM)
    setErrors({})
    setFormError('')
  }
  const cancel = () => {
    const hasDraft = Object.values(values).some((value) => value !== '')
    if (hasDraft && !window.confirm('Cancel this analysis and discard the saved draft?')) return
    if (!clearAnalysisDraft(sessionStorage)) {
      setFormError('The draft could not be cleared from this tab. Your entered values were kept.')
      return
    }
    onCancel()
  }
  const currencySymbol = (() => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency } catch { return currency }
  })()
  return <>
    <PageHeading eyebrow="Profitability" title="New analysis" subtitle="Enter the details below to understand the true profitability of a sale." />
    {formError && <div className="alert" role="alert">{formError}</div>}
    <form className="card form-card" onSubmit={submit} noValidate>
      <section className="form-section">
        <h2 className="form-section-title">Product & sale details</h2>
        <div className="field-grid three">
          <FormField label="Product or service" required error={errors.productName}><input value={values.productName} aria-invalid={!!errors.productName} onChange={(e) => set('productName', e.target.value)} placeholder="e.g. Handmade candle" /></FormField>
          <FormField label="Quantity sold" required error={errors.quantity}><input type="number" min="0" step="any" value={values.quantity} aria-invalid={!!errors.quantity} onChange={(e) => set('quantity', e.target.value)} placeholder="0" /></FormField>
          <FormField label={`Selling price per unit (${currency})`} required error={errors.sellingPrice}><MoneyInput currencySymbol={currencySymbol} value={values.sellingPrice} onChange={(v) => set('sellingPrice', v)} error={!!errors.sellingPrice} /></FormField>
          <FormField label={`Cost per unit (${currency})`} required error={errors.costPerUnit}><MoneyInput currencySymbol={currencySymbol} value={values.costPerUnit} onChange={(v) => set('costPerUnit', v)} error={!!errors.costPerUnit} /></FormField>
          <FormField label="Customer name"><input value={values.customerName} onChange={(e) => set('customerName', e.target.value)} placeholder="Optional" /></FormField>
        </div>
      </section>
      <section className="form-section">
        <h2 className="form-section-title">Additional expenses <span style={{ color: '#97a2ae', fontWeight: 400 }}>· Optional</span></h2>
        <div className="field-grid three">
          <FormField label={`Additional product expenses (${currency})`} error={errors.additionalProductExpenses}><MoneyInput currencySymbol={currencySymbol} value={values.additionalProductExpenses} onChange={(v) => set('additionalProductExpenses', v)} error={!!errors.additionalProductExpenses} /></FormField>
          <FormField label={`Additional customer expenses (${currency})`} error={errors.additionalCustomerExpenses}><MoneyInput currencySymbol={currencySymbol} value={values.additionalCustomerExpenses} onChange={(v) => set('additionalCustomerExpenses', v)} error={!!errors.additionalCustomerExpenses} /></FormField>
          <FormField label={`Allocated shared expenses (${currency})`} error={errors.sharedExpenses}><MoneyInput currencySymbol={currencySymbol} value={values.sharedExpenses} onChange={(v) => set('sharedExpenses', v)} error={!!errors.sharedExpenses} /></FormField>
        </div>
      </section>
      <div className="form-actions"><button type="button" className="btn btn-outline" onClick={clear} disabled={saving}>Reset</button><button type="button" className="btn btn-outline" onClick={cancel} disabled={saving}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : <><BarChart3 />Calculate profitability</>}</button></div>
    </form>
  </>
}

function FormField({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: ReactNode }) {
  return <div className="field"><label>{label}{required && <span> *</span>}</label>{children}{error && <small className="field-error">{error}</small>}</div>
}

function MoneyInput({ currencySymbol, value, onChange, error }: { currencySymbol: string; value: string; onChange: (value: string) => void; error: boolean }) {
  return <div className="input-prefix"><span>{currencySymbol}</span><input type="number" min="0" step="0.01" value={value} aria-invalid={error} onChange={(event) => onChange(event.target.value)} placeholder="0.00" /></div>
}

function Results({ analysis, currency, onHistory, onNew }: { analysis: Analysis; currency: string; onHistory: () => void; onNew: () => void }) {
  const positive = analysis.profit >= 0
  const data = chartData([analysis], currency)
  const suggestions = useMemo(() => {
    if (analysis.revenue === 0) return ['There is no revenue for this analysis. Add a selling price or quantity to calculate a profit margin.']
    if (analysis.profit < 0) return [
      `Costs exceed revenue by ${money(Math.abs(analysis.profit), currency)}. Review pricing and costs before repeating this sale.`,
      'Consider reducing additional expenses or negotiating a lower unit cost.',
    ]
    if (analysis.margin !== null && analysis.margin < 15) return [
      `Your ${analysis.margin.toFixed(1)}% margin is relatively thin. A small change in costs could reduce profitability.`,
      'Review allocated expenses and consider whether a modest price adjustment is possible.',
    ]
    return [
      `This sale generated a ${analysis.margin?.toFixed(1)}% profit margin.`,
      'Track the same expense categories on future analyses to compare profitability over time.',
    ]
  }, [analysis, currency])
  const extra = analysis.additionalProductExpenses + analysis.additionalCustomerExpenses + analysis.sharedExpenses
  return <>
    <PageHeading eyebrow="Analysis results" title={analysis.productName} subtitle={`${shortDate(analysis.createdAt)}${analysis.customerName ? ` · ${analysis.customerName}` : ''}`}
      action={<div style={{ display: 'flex', gap: 8 }}><button className="btn btn-outline" onClick={onHistory}>History</button><button className="btn btn-primary" onClick={onNew}><Plus />New analysis</button></div>} />
    <div className={`result-hero${positive ? '' : ' loss'}`}>
      <div><div className="eyebrow">{positive ? 'Profitable sale' : 'Sale at a loss'}</div><h2>Net {positive ? 'profit' : 'loss'}</h2></div>
      <div className={`result-big${positive ? '' : ' loss'}`}>{money(analysis.profit, currency)}</div>
    </div>
    <div className="result-kpis">
      <div className="card result-kpi"><span>Revenue</span><strong>{money(analysis.revenue, currency)}</strong></div>
      <div className="card result-kpi"><span>Total cost</span><strong>{money(analysis.totalCost, currency)}</strong></div>
      <div className="card result-kpi"><span>Profit margin</span><strong>{analysis.margin === null ? 'N/A' : `${analysis.margin.toFixed(1)}%`}</strong></div>
    </div>
    <div className="result-layout">
      <div className="card card-pad">
        <h2 className="card-title">Calculation breakdown</h2><p className="card-subtitle">A transparent view of how this result was calculated.</p>
        <div className="breakdown-list">
          <div className="breakdown-line"><span>Quantity sold × selling price</span><strong>{analysis.quantity} × {money(analysis.sellingPrice, currency)}</strong></div>
          <div className="breakdown-line"><span>Revenue</span><strong>{money(analysis.revenue, currency)}</strong></div>
          <div className="breakdown-line"><span>Direct cost ({analysis.quantity} × {money(analysis.costPerUnit, currency)})</span><strong>− {money(analysis.directCost, currency)}</strong></div>
          <div className="breakdown-line"><span>Additional expenses</span><strong>− {money(extra, currency)}</strong></div>
          <div className="breakdown-line total"><span>Total cost</span><strong>{money(analysis.totalCost, currency)}</strong></div>
          <div className="breakdown-line final"><span>Profit / loss</span><strong className={positive ? 'profit-text' : 'loss-text'}>{money(analysis.profit, currency)}</strong></div>
          <div className="breakdown-line"><span>Profit margin</span><strong>{analysis.margin === null ? 'N/A' : `${analysis.margin.toFixed(2)}%`}</strong></div>
        </div>
      </div>
      <div>
        <div className="card chart-card" style={{ minHeight: 255, marginBottom: 15 }}>
          <div className="card-title-row"><div><h2 className="card-title">Revenue vs. cost</h2><p className="card-subtitle">For this analysis</p></div></div>
          <RevenueCostChart data={data} currency={currency} />
        </div>
        <div className="card card-pad">
          <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Lightbulb size={15} color="#479174" />Suggestions</h2>
          <ul className="suggestion-list">{suggestions.map((text) => <li className={`suggestion${!positive ? ' warning' : ''}`} key={text}><Check />{text}</li>)}</ul>
        </div>
      </div>
    </div>
  </>
}

function MissingResult({ onHistory }: { onHistory: () => void }) {
  return <div className="card table-empty" style={{ marginTop: 60 }}><Package /><strong>Analysis not found</strong><p>It may have been removed from your saved history.</p><button className="btn btn-primary" onClick={onHistory}>Go to analysis history</button></div>
}

function History({ analyses, currency, localOnlyIds, onView, onDelete, onNew }: {
  analyses: Analysis[]; currency: string; localOnlyIds: ReadonlySet<string>
  onView: (analysis: Analysis) => void; onDelete: (id: string) => void; onNew: () => void
}) {
  const [query, setQuery] = useState('')
  const filtered = analyses.filter((item) => `${item.productName} ${item.customerName}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <PageHeading eyebrow="Your workspace" title="Analysis history" subtitle={`${analyses.length} saved ${analyses.length === 1 ? 'analysis' : 'analyses'}`}
      action={<button className="btn btn-primary" onClick={onNew}><Plus />New analysis</button>} />
    <div className="card section-card">
      <div className="section-header"><div><h2 className="card-title">Saved calculations</h2><p className="card-subtitle">Open a result or remove a record from this browser.</p></div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search analyses" placeholder="Search product or customer" style={{ width: 220, height: 35, padding: '0 10px', border: '1px solid #e1e6e9', borderRadius: 7, fontSize: 11 }} />
      </div>
      {filtered.length ? <AnalysisTable analyses={filtered} currency={currency} localOnlyIds={localOnlyIds} onView={onView} onDelete={onDelete} /> :
        <div className="table-empty"><Package /><strong>{analyses.length ? 'No matching analyses' : 'No saved analyses yet'}</strong><p>{analyses.length ? 'Try a different product or customer name.' : 'Your completed calculations will appear here.'}</p>{!analyses.length && <button className="btn btn-primary" onClick={onNew}><Plus />Create first analysis</button>}</div>}
    </div>
  </>
}

function Reports({ analyses, currency }: { analyses: Analysis[]; currency: string }) {
  const totals = totalsFor(analyses)
  const margin = totals.revenue === 0 ? null : totals.profit / totals.revenue * 100
  const products = Object.values(analyses.reduce<Record<string, { name: string; profit: number; revenue: number; count: number }>>((acc, item) => {
    const key = item.productName.trim().toLocaleLowerCase()
    acc[key] ??= { name: item.productName, profit: 0, revenue: 0, count: 0 }
    acc[key].profit += item.profit
    acc[key].revenue += item.revenue
    acc[key].count += 1
    return acc
  }, {}))
  const best = [...products].sort((a, b) => b.profit - a.profit)[0]
  const lowestMargin = analyses.filter((item) => item.margin !== null).sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0))[0]
  const data = chartData([...analyses].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-8), currency)
  return <>
    <PageHeading eyebrow="Business insights" title="Reports" subtitle="A summary of your saved profitability analyses."
      action={<button className="btn btn-outline" onClick={() => window.print()}><FileBarChart />Print report</button>} />
    <div className="report-grid">
      <MetricCard label="Revenue" value={money(totals.revenue, currency)} foot="All saved analyses" icon={CircleDollarSign} />
      <MetricCard label="Total cost" value={money(totals.cost, currency)} foot="All recorded costs" icon={Wallet} />
      <MetricCard label="Profit / loss" value={money(totals.profit, currency)} foot={`${analyses.length} saved ${analyses.length === 1 ? 'analysis' : 'analyses'}`} icon={totals.profit >= 0 ? ArrowUpRight : ArrowDownRight} mood={totals.profit >= 0 ? 'good' : 'bad'} />
      <MetricCard label="Overall margin" value={margin === null ? 'N/A' : `${margin.toFixed(1)}%`} foot="Weighted by total revenue" icon={TrendingUp} />
    </div>
    <div className="insight-grid">
      <div className="card insight-card"><div className="insight-label">Best-performing product</div><div className="insight-value">{best?.name ?? 'Not enough data'}</div><div className="insight-note">{best ? `${money(best.profit, currency)} total profit · ${best.count} ${best.count === 1 ? 'analysis' : 'analyses'}` : 'Save an analysis to see product insights.'}</div></div>
      <div className="card insight-card"><div className="insight-label">Lowest-margin analysis</div><div className="insight-value">{lowestMargin?.productName ?? 'Not enough data'}</div><div className="insight-note">{lowestMargin ? `${lowestMargin.margin?.toFixed(1)}% margin · ${shortDate(lowestMargin.createdAt)}` : 'A revenue-bearing analysis is needed to calculate margin.'}</div></div>
    </div>
    <div className="card chart-card" style={{ minHeight: 335 }}>
      <div className="card-title-row"><div><h2 className="card-title">Revenue vs. cost</h2><p className="card-subtitle">Up to the 8 most recent saved analyses</p></div><div className="legend"><span className="legend-item"><i className="legend-dot" />Revenue</span><span className="legend-item"><i className="legend-dot cost" />Cost</span></div></div>
      <div style={{ height: 265 }}><RevenueCostChart data={data} currency={currency} /></div>
    </div>
    {analyses.length === 0 && <p className="card-subtitle" style={{ margin: '14px 2px' }}>This report is based only on your saved records. Create an analysis to populate it.</p>}
  </>
}

function SettingsPage({ profile, darkMode, emailReadOnly, onSave, onAvatarSave, onToggleTheme, onClear }: {
  profile: Profile; darkMode: boolean; emailReadOnly: boolean
  onSave: (profile: Profile) => Promise<void>; onAvatarSave: (avatar: string) => void
  onToggleTheme: () => void; onClear: () => void
}) {
  const [values, setValues] = useState(profile)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [cropSource, setCropSource] = useState<string | null>(null)
  const [cropZoom, setCropZoom] = useState(CIRCULAR_CROP_MIN_ZOOM)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const set = (key: keyof Profile, value: string) => setValues((current) => ({ ...current, [key]: value }))
  const choosePicture = (file?: File) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPG, PNG, or WebP image.')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('Choose an image smaller than 15 MB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCropSource(reader.result)
        setError('')
      } else {
        setError('The selected image could not be read. Please choose another file.')
      }
    }
    reader.onerror = () => setError('The selected image could not be read. Please choose another file.')
    reader.readAsDataURL(file)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!values.fullName.trim() || !values.email.trim()) {
      setError('Name and email are required.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      setError('Enter a valid email address.')
      return
    }
    if (values.phoneNumber?.trim() && (!/^[+\d().\-\s]+$/.test(values.phoneNumber) || values.phoneNumber.replace(/\D/g, '').length < 7)) {
      setError('Enter a valid phone number or leave the field blank.')
      return
    }
    let businessWebsite = values.businessWebsite?.trim() ?? ''
    if (businessWebsite && !/^https?:\/\//i.test(businessWebsite)) businessWebsite = `https://${businessWebsite}`
    if (businessWebsite) {
      try {
        const website = new URL(businessWebsite)
        if (!['http:', 'https:'].includes(website.protocol)) throw new Error('Unsupported protocol')
      } catch {
        setError('Enter a valid business website, such as example.com.')
        return
      }
    }
    setError('')
    setSaving(true)
    try {
      await onSave({
        ...values,
        fullName: values.fullName.trim(),
        email: values.email.trim(),
        businessName: values.businessName.trim(),
        jobTitle: values.jobTitle?.trim() ?? '',
        phoneNumber: values.phoneNumber?.trim() ?? '',
        businessWebsite,
        businessLocation: values.businessLocation?.trim() ?? '',
        businessDescription: values.businessDescription?.trim() ?? '',
      })
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save your profile.')
    } finally {
      setSaving(false)
    }
  }
  return <>
    <PageHeading eyebrow="Preferences" title="Profile & settings" subtitle="Manage your business profile and local app preferences." />
    <div className="settings-layout">
      <form className="card form-card" onSubmit={submit}>
        <div className="settings-card-heading">
          <div><h2 className="card-title">Profile & business details</h2><p className="card-subtitle">Keep your workspace information up to date.</p></div>
        </div>
        {error && <div className="alert" role="alert">{error}</div>}
        <section className="profile-picture-section">
          <div className="profile-picture-preview"><ProfileAvatar profile={values} className="avatar profile-avatar-large" /></div>
          <div className="profile-picture-controls">
            <strong>Profile picture</strong>
            <p>Upload a photo or choose an avatar style.</p>
            <div className="profile-picture-actions">
              <button type="button" className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>
                <Upload />{values.avatar?.startsWith('data:image/') ? 'Replace photo' : 'Upload photo'}
              </button>
              {values.avatar?.startsWith('data:image/') && <button type="button" className="btn btn-link"
                onClick={() => { setCropSource(values.avatar ?? null); setCropZoom(CIRCULAR_CROP_MIN_ZOOM); setError('') }}>Edit photo</button>}
              <button type="button" className="btn btn-link" onClick={() => { set('avatar', ''); setError('') }}>Remove picture</button>
              <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp"
                aria-label="Upload profile picture" onChange={(event) => {
                  choosePicture(event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }} />
            </div>
            <div className="avatar-choices" role="group" aria-label="Choose a built-in avatar">
              {AVATAR_CHOICES.map((choice) => (
                <button key={choice.id} type="button" className={`avatar-choice${values.avatar === choice.id ? ' selected' : ''}`}
                  aria-label={choice.label} aria-pressed={values.avatar === choice.id}
                  onClick={() => { set('avatar', choice.id); setError('') }}>
                  <ProfileAvatar profile={{ ...values, avatar: choice.id }} className="avatar" />
                </button>
              ))}
            </div>
            <small>Images are stored in this browser only and are not synced to other devices. JPG, PNG, or WebP up to 15 MB.</small>
          </div>
        </section>
        {cropSource && <ProfilePhotoEditor key={cropSource} imageSrc={cropSource} initialZoom={cropZoom} error={error} onCancel={() => setCropSource(null)}
          onReplace={() => fileInputRef.current?.click()} onError={setError} onSave={(avatar) => {
            set('avatar', avatar)
            setCropZoom(CIRCULAR_CROP_MIN_ZOOM)
            onAvatarSave(avatar)
            setCropSource(null)
            setError('')
          }} />}
        <h3 className="settings-section-label">Your details</h3>
        <div className="field-grid compact">
          <Field label="Full name" required><input value={values.fullName} onChange={(e) => set('fullName', e.target.value)} /></Field>
          <Field label="Email address" required><input type="email" value={values.email} readOnly={emailReadOnly} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Job title or role"><input value={values.jobTitle ?? ''} onChange={(e) => set('jobTitle', e.target.value)} placeholder="e.g. Owner" /></Field>
          <Field label="Phone number"><input type="tel" value={values.phoneNumber ?? ''} onChange={(e) => set('phoneNumber', e.target.value)} placeholder="Optional" /></Field>
        </div>
        <h3 className="settings-section-label">Business details</h3>
        <div className="field-grid compact">
          <Field label="Business name"><input value={values.businessName} onChange={(e) => set('businessName', e.target.value)} /></Field>
          <Field label="Business type"><select value={values.businessType} onChange={(e) => set('businessType', e.target.value)}><option value="">Select type</option>{BUSINESS_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field>
          <Field label="Preferred currency" required><select value={values.currency} onChange={(e) => set('currency', e.target.value)}>{CURRENCIES.map((code) => <option key={code}>{code}</option>)}</select></Field>
          <Field label="Business website"><input type="url" value={values.businessWebsite ?? ''} onChange={(e) => set('businessWebsite', e.target.value)} placeholder="example.com" /></Field>
          <Field label="Business location"><input value={values.businessLocation ?? ''} onChange={(e) => set('businessLocation', e.target.value)} placeholder="City, country" /></Field>
          <Field label="Short business description"><textarea maxLength={240} value={values.businessDescription ?? ''} onChange={(e) => set('businessDescription', e.target.value)} placeholder="What does your business do?" /></Field>
        </div>
        <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
      </form>
      <div>
        <div className="card card-pad">
          <h2 className="card-title">Preferences</h2>
          <div className="toggle-row"><div className="toggle-copy"><strong>Appearance</strong><small>Choose a comfortable color theme.</small></div><button className={`switch${darkMode ? ' on' : ''}`} role="switch" aria-checked={darkMode} aria-label="Toggle dark mode" onClick={onToggleTheme} /></div>
        </div>
        <div className="settings-note" style={{ marginTop: 14 }}>{emailReadOnly
          ? 'Your name, business name, business type, and currency are saved to your Supabase profile. Profile photos and additional contact details remain in this browser because they are not columns in the profiles table.'
          : 'This local demo profile and its settings are stored in this browser. The demo password is not retained and is not used for authentication.'}</div>
        <div className="danger-zone"><strong>Clear local data</strong><p>{emailReadOnly
          ? 'Remove saved analyses and settings from this browser. Your Supabase profile will not be deleted.'
          : 'Remove your profile, settings, and all saved analyses from this browser. This action cannot be undone.'}</p><button className="btn btn-danger" onClick={onClear}><Trash2 />Clear local data</button></div>
      </div>
    </div>
  </>
}

export default App
