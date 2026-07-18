import { getSupabaseAdmin } from './supabase-admin'
import { isPromotionalCampaign } from './campaigns'

const API_PATH = '/api_produto/lojaomoveis/consultas'
const STOCK_FETCH_CONCURRENCY = 12

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>

// Light stock refresh: re-read only the quantities of a campaign's already-synced
// products/variants (no catalog scan). Powers both the manual button and the 30-min job.
export async function refreshCampaignStock(externalIds?: number[]) {
  const supabase = getSupabaseAdmin()
  const today = new Date().toISOString().slice(0, 10)

  const targetExternalIds =
    externalIds && externalIds.length > 0
      ? externalIds
      : await getVigenteCampaignExternalIds(supabase, today)

  if (targetExternalIds.length === 0) {
    return { refreshed: false, externalIds: [], updated: 0 }
  }

  const { data: sources, error } = await supabase
    .from('integration_sources')
    .select('id, source_key, env_token_name, sgi_base_url')
    .eq('is_active', true)

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  let updated = 0
  for (const source of sources ?? []) {
    const token = process.env[source.env_token_name as string]
    if (!token) {
      continue
    }

    const { productMap, variantMap, codes } = await getCampaignItems(
      supabase,
      source.id,
      targetExternalIds
    )
    if (codes.length === 0) {
      continue
    }

    const baseUrl = (source.sgi_base_url as string) || process.env.SGI_BASE_URL || ''
    const stocks = await fetchStocksByCodes(baseUrl, token, codes)
    updated += await upsertCurrentStock(supabase, source.id, stocks, productMap, variantMap)
  }

  return { refreshed: true, externalIds: targetExternalIds, updated }
}

// Returns the newest stock capture time (ms) among a campaign's products, so the API can
// throttle repeated manual refreshes.
export async function getCampaignStockAgeMs(externalIds: number[]): Promise<number | null> {
  const supabase = getSupabaseAdmin()
  const { productMap } = await collectCampaignProductIds(supabase, externalIds)
  const productIds = [...productMap.values()]
  if (productIds.length === 0) {
    return null
  }

  const { data, error } = await supabase
    .from('product_stock_current')
    .select('captured_at')
    .in('product_id', productIds.slice(0, 200))
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data?.captured_at) {
    return null
  }

  return Date.now() - new Date(data.captured_at).getTime()
}

async function getVigenteCampaignExternalIds(
  supabase: SupabaseAdmin,
  today: string
): Promise<number[]> {
  const { data, error } = await supabase
    .from('price_tables')
    .select('external_id, descricao, validade_inicial, validade_final')
    .lte('validade_inicial', today)
    .gte('validade_final', today)

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  const ids = new Set<number>()
  for (const row of data ?? []) {
    if (isPromotionalCampaign(row.descricao, row.validade_inicial, row.validade_final)) {
      ids.add(Number(row.external_id))
    }
  }
  return [...ids]
}

async function collectCampaignProductIds(supabase: SupabaseAdmin, externalIds: number[]) {
  const productMap = new Map<number, string>()
  const variantMap = new Map<number, string>()

  const { data: tables } = await supabase
    .from('price_tables')
    .select('id')
    .in('external_id', externalIds)

  const tableIds = (tables ?? []).map((row: any) => row.id)
  if (tableIds.length === 0) {
    return { productMap, variantMap, tableIds }
  }

  const { data: productPrices } = await supabase
    .from('product_prices')
    .select('product_id, products ( id, external_id )')
    .in('price_table_id', tableIds)

  for (const row of (productPrices ?? []) as any[]) {
    if (row.products?.external_id != null) {
      productMap.set(Number(row.products.external_id), row.products.id)
    }
  }

  const { data: variantPrices } = await supabase
    .from('product_variant_prices')
    .select('variant_id, product_variants ( id, external_id )')
    .in('price_table_id', tableIds)

  for (const row of (variantPrices ?? []) as any[]) {
    if (row.product_variants?.external_id != null) {
      variantMap.set(Number(row.product_variants.external_id), row.product_variants.id)
    }
  }

  return { productMap, variantMap, tableIds }
}

async function getCampaignItems(
  supabase: SupabaseAdmin,
  integrationSourceId: string,
  externalIds: number[]
) {
  const productMap = new Map<number, string>()
  const variantMap = new Map<number, string>()
  const codes = new Set<string>()

  const { data: tables } = await supabase
    .from('price_tables')
    .select('id')
    .eq('integration_source_id', integrationSourceId)
    .in('external_id', externalIds)

  const tableIds = (tables ?? []).map((row: any) => row.id)
  if (tableIds.length === 0) {
    return { productMap, variantMap, codes: [] as string[] }
  }

  const { data: productPrices } = await supabase
    .from('product_prices')
    .select('products ( id, external_id, codigo )')
    .in('price_table_id', tableIds)

  for (const row of (productPrices ?? []) as any[]) {
    const product = row.products
    if (product?.external_id != null) {
      productMap.set(Number(product.external_id), product.id)
      if (product.codigo) {
        codes.add(product.codigo)
      }
    }
  }

  const { data: variantPrices } = await supabase
    .from('product_variant_prices')
    .select('product_variants ( id, external_id, codigo )')
    .in('price_table_id', tableIds)

  for (const row of (variantPrices ?? []) as any[]) {
    const variant = row.product_variants
    if (variant?.external_id != null) {
      variantMap.set(Number(variant.external_id), variant.id)
      if (variant.codigo) {
        codes.add(variant.codigo)
      }
    }
  }

  return { productMap, variantMap, codes: [...codes] }
}

async function fetchStocksByCodes(baseUrl: string, token: string, codes: string[]) {
  const results: any[] = []

  for (let index = 0; index < codes.length; index += STOCK_FETCH_CONCURRENCY) {
    const batch = codes.slice(index, index + STOCK_FETCH_CONCURRENCY)
    const responses = await Promise.all(
      batch.map((code) => fetchStockByCode(baseUrl, token, code))
    )
    for (const items of responses) {
      results.push(...items)
    }
  }

  return results
}

async function fetchStockByCode(baseUrl: string, token: string, code: string) {
  const url = new URL(`${API_PATH}/estoques`, baseUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('codigo', code)
  url.searchParams.set('ativo', 'true')

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!response.ok) {
        throw new Error(`status ${response.status}`)
      }
      const json: any = await response.json()
      return Array.isArray(json.estoques) ? json.estoques : []
    } catch (error) {
      if (attempt === 3) {
        return []
      }
    }
  }

  return []
}

async function upsertCurrentStock(
  supabase: SupabaseAdmin,
  integrationSourceId: string,
  stocks: any[],
  productMap: Map<number, string>,
  variantMap: Map<number, string>
) {
  const timestamp = new Date().toISOString()
  const productRows: any[] = []
  const variantRows: any[] = []

  for (const item of stocks) {
    const quantity = Number(String(item.quantidade_disponivel ?? '0').replace(',', '.')) || 0
    const productId = productMap.get(Number(item.id))
    if (productId) {
      productRows.push({
        product_id: productId,
        integration_source_id: integrationSourceId,
        quantity_available: quantity,
        captured_at: timestamp
      })
      continue
    }

    const variantId = variantMap.get(Number(item.id))
    if (variantId) {
      variantRows.push({
        variant_id: variantId,
        integration_source_id: integrationSourceId,
        quantity_available: quantity,
        captured_at: timestamp
      })
    }
  }

  for (const rows of chunk(productRows, 200)) {
    const { error } = await supabase
      .from('product_stock_current')
      .upsert(rows, { onConflict: 'product_id,integration_source_id' })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
  }

  for (const rows of chunk(variantRows, 200)) {
    const { error } = await supabase
      .from('product_variant_stock_current')
      .upsert(rows, { onConflict: 'variant_id,integration_source_id' })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
  }

  return productRows.length + variantRows.length
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}
