import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const API_PATH = '/api_produto/lojaomoveis/consultas'
const PAGE_SIZE = 30
const UPSERT_BATCH_SIZE = 200
const INSERT_BATCH_SIZE = 500

loadEnvFile('.env')

const requiredEnvNames = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SGI_BASE_URL'
]

for (const envName of requiredEnvNames) {
  if (!process.env[envName]) {
    throw new Error(`Missing required environment variable: ${envName}`)
  }
}

const selectedSource = getArgValue('--source')
const selectedPriceTableId = getArgValue('--price-table-id')
const selectedCampaign = getArgValue('--campaign')
const selectedVigente = process.argv.includes('--vigente')
// Light refresh: only re-read quantities for products already synced (no catalog scan).
const selectedStockOnly = process.argv.includes('--stock-only')
const selectedLimit = toNullableInteger(getArgValue('--limit'))
const selectedCodes = getSelectedCodes()

// Sentinel end date of the permanent base price table (0001-01-01 .. 9999-01-01).
const CAMPAIGN_END_SENTINEL = '9000-01-01'
const TODAY = new Date().toISOString().slice(0, 10)
// Promotional campaigns run for a bounded window and aren't internal/base tables.
const MAX_PROMO_DAYS = 120
const INTERNAL_TABLE_NAME_PATTERN = /INTERNA|CUSTO|E-?COM+ERCE|TABELA DE PRE[CÇ]OS/i
// The listing lags behind; probe ids past the last listed one until this many
// consecutive ids are missing, to catch newly-created campaign tables.
const PROBE_MISS_LIMIT = 15
// How many catalog pages to fetch in parallel when scanning a price table for its
// priced members (the SGI API has no server-side filter, so the whole catalog is read).
const PRICE_SCAN_CONCURRENCY = 8

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

const integrationSources = await getIntegrationSources(supabase, selectedSource)

if (integrationSources.length === 0) {
  throw new Error(
    selectedSource
      ? `No active integration source found for source_key="${selectedSource}".`
      : 'No active integration sources found.'
  )
}

for (const source of integrationSources) {
  if (selectedStockOnly) {
    await syncStockOnly(source)
  } else {
    await syncSource(source)
  }
}

if (!selectedStockOnly) {
  await pruneVariantProducts()
}

console.log(`Sync completed for ${integrationSources.length} source(s).`)

async function syncSource(source) {
  const token = process.env[source.env_token_name]
  if (!token) {
    console.warn(
      `[${source.source_key}] skipped because env token ${source.env_token_name} is empty.`
    )
    return
  }

  console.log(`[${source.source_key}] starting sync for ${source.name}`)

  const syncRunId = await createSyncRun(source.id)

  try {
    let products = []
    let variantProducts = []
    let stocks = []
    let pricesPayload = []

    if (selectedPriceTableId || selectedCampaign || selectedVigente) {
      console.log(`[${source.source_key}] loading price table target`)
      const targetTables = selectedVigente
        ? await fetchVigentePromotionalTables(source.sgi_base_url, token)
        : selectedPriceTableId && !selectedCampaign
          ? [await fetchPriceTableById(source.sgi_base_url, token, selectedPriceTableId)]
          : [
              await fetchTargetPriceTable(
                source.sgi_base_url,
                token,
                selectedPriceTableId,
                selectedCampaign
              )
            ]

      if (selectedVigente) {
        if (targetTables.length === 0) {
          console.warn(`[${source.source_key}] no vigente promotional price table for ${TODAY}; skipping campaign sync.`)
        } else {
          console.log(
            `[${source.source_key}] vigente promotional tables (${targetTables.length}): ` +
              targetTables
                .map((entry) => `${entry.tabela_preco.id} ${entry.tabela_preco.descricao}`)
                .join(' | ')
          )
        }
      }

      // Candidate products are the same regardless of table; fetch once when using codes.
      const candidateProducts = selectedCodes.length > 0
        ? await fetchItemsByCodes(
            source.sgi_base_url,
            'produtos',
            token,
            'produtos',
            selectedCodes,
            { ativo: 'true' }
          )
        : []

      const productsById = new Map()
      const variantsById = new Map()
      const stockCodes = new Set()

      for (const targetPriceTable of targetTables) {
        const priceTableId = targetPriceTable.tabela_preco.id
        let matchingProducts

        if (selectedCodes.length > 0) {
          console.log(`[${source.source_key}] filtering products by price table ${priceTableId}`)
          matchingProducts = await filterProductsByPriceTable(
            source.sgi_base_url,
            token,
            priceTableId,
            candidateProducts
          )
        } else {
          console.log(`[${source.source_key}] loading campaign products from price table ${priceTableId}`)
          matchingProducts = await fetchProductsForPriceTable(
            source.sgi_base_url,
            token,
            priceTableId,
            selectedLimit
          )
        }

        const variantDescriptors = collectVariantDescriptors(matchingProducts.products)
        const tableVariants = await fetchVariantProducts(
          source.sgi_base_url,
          token,
          variantDescriptors
        )
        const variantPriceProducts = await fetchPriceProductsByCodes(
          source.sgi_base_url,
          token,
          priceTableId,
          tableVariants.map((item) => item.codigo)
        )

        for (const product of matchingProducts.products) {
          productsById.set(Number(product.id), product)
        }
        for (const variant of tableVariants) {
          variantsById.set(Number(variant.id), variant)
        }

        const tablePriceProducts = [...matchingProducts.priceProducts, ...variantPriceProducts]
        for (const item of tablePriceProducts) {
          if (item.codigo) {
            stockCodes.add(item.codigo)
          }
        }

        pricesPayload.push({
          tabela_preco: {
            ...targetPriceTable.tabela_preco,
            produtos: tablePriceProducts
          }
        })
      }

      // A grade SKU (e.g. 3683-1) is a color variant of its parent (3683) and comes
      // back from the price scan as its own row. It must be a variant, not a standalone
      // product — drop any product whose codigo is listed as a grade of another product.
      const gradeChildCodes = new Set()
      for (const product of productsById.values()) {
        for (const grade of product.grades ?? []) {
          if (grade.codigo) {
            gradeChildCodes.add(grade.codigo)
          }
        }
      }

      products = [...productsById.values()].filter(
        (product) => !gradeChildCodes.has(product.codigo)
      )
      variantProducts = [...variantsById.values()]

      console.log(`[${source.source_key}] loading stocks`)
      stocks = await fetchItemsByCodes(
        source.sgi_base_url,
        'estoques',
        token,
        'estoques',
        [...stockCodes],
        { ativo: 'true' }
      )
    } else {
      console.log(`[${source.source_key}] loading products`)
      products = await fetchAllPages(source.sgi_base_url, 'produtos', token, 'produtos', {
        ativo: 'true'
      })
      console.log(`[${source.source_key}] loading variant products`)
      variantProducts = await fetchVariantProducts(
        source.sgi_base_url,
        token,
        collectVariantDescriptors(products)
      )
      console.log(`[${source.source_key}] loading stocks`)
      stocks = await fetchAllPages(source.sgi_base_url, 'estoques', token, 'estoques', {
        ativo: 'true'
      })
      console.log(`[${source.source_key}] loading prices`)
      pricesPayload = await fetchAllPages(source.sgi_base_url, 'precos', token, 'precos', {
        ativo: 'true'
      })
    }

    const productExternalIds = [...new Set(products.map((item) => Number(item.id)).filter(Boolean))]

    console.log(`[${source.source_key}] upserting products`)
    await upsertProducts(products)
    console.log(`[${source.source_key}] fetching product map`)
    const productMap = await getProductsMap(productExternalIds)
    console.log(`[${source.source_key}] upserting variants`)
    await upsertProductVariants(
      variantProducts,
      collectVariantDescriptors(products),
      productMap
    )
    console.log(`[${source.source_key}] fetching variant map`)
    const variantMap = await getProductVariantsMap(
      variantProducts.map((item) => Number(item.id)).filter(Boolean)
    )
    console.log(`[${source.source_key}] replacing product images`)
    await replaceProductImages(products, productMap)
    console.log(`[${source.source_key}] replacing kit items`)
    await replaceProductKitItems(products, productMap)
    console.log(`[${source.source_key}] replacing variant images`)
    await replaceProductVariantImages(variantProducts, variantMap)
    console.log(`[${source.source_key}] upserting prices`)
    await upsertPriceTablesAndPrices(source.id, pricesPayload, productMap, variantMap)
    console.log(`[${source.source_key}] upserting stocks`)
    const stockSyncResult = await upsertStocks(
      source.id,
      stocks,
      productMap,
      variantMap,
      syncRunId
    )

    console.log(`[${source.source_key}] finalizing sync run`)
    await updateSyncRun(syncRunId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      records_received: products.length + variantProducts.length + stocks.length + pricesPayload.length,
      records_upserted:
        products.length +
        variantProducts.length +
        stockSyncResult.changedCurrentRows +
        stockSyncResult.insertedSnapshots,
      metadata: {
        products_count: products.length,
        variants_count: variantProducts.length,
        stocks_count: stocks.length,
        price_tables_count: pricesPayload.length,
        stock_rows_changed: stockSyncResult.changedCurrentRows,
        stock_snapshots_inserted: stockSyncResult.insertedSnapshots
      }
    })

    console.log(
      `[${source.source_key}] sync finished: ${products.length} products, ${variantProducts.length} variants, ${stocks.length} stock rows, ${pricesPayload.length} price tables`
    )
  } catch (error) {
    await updateSyncRun(syncRunId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : String(error)
    })

    throw error
  }
}

async function pruneVariantProducts() {
  // A grade SKU can slip into `products` (as a priced row) while also being a variant.
  // It must live only as a variant — delete any product whose external_id is a variant
  // id. Cascades remove its product-level prices/stock/images.
  const variantExternalIds = new Set()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('product_variants')
      .select('external_id')
      .range(from, from + 999)

    if (error) {
      throw error
    }
    if (!data || data.length === 0) {
      break
    }

    for (const row of data) {
      if (row.external_id != null) {
        variantExternalIds.add(Number(row.external_id))
      }
    }
    if (data.length < 1000) {
      break
    }
  }

  const productIds = []
  for (const idsChunk of chunk([...variantExternalIds], UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('products')
      .select('id')
      .in('external_id', idsChunk)

    if (error) {
      throw error
    }
    for (const row of data ?? []) {
      productIds.push(row.id)
    }
  }

  let removed = 0
  for (const idsChunk of chunk(productIds, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase.from('products').delete().in('id', idsChunk)
    if (error) {
      throw error
    }
    removed += idsChunk.length
  }

  if (removed > 0) {
    console.log(`pruned ${removed} grade product(s) that duplicate variants`)
  }
}

// Light refresh: re-read only the quantities of a campaign's already-synced products,
// skipping the heavy catalog scan (prices/membership don't change during a campaign).
async function syncStockOnly(source) {
  const token = process.env[source.env_token_name]
  if (!token) {
    console.warn(`[${source.source_key}] skipped: env token ${source.env_token_name} is empty.`)
    return
  }

  const externalIds = selectedPriceTableId
    ? [Number(selectedPriceTableId)]
    : await getVigenteCampaignExternalIds()

  if (externalIds.length === 0) {
    console.warn(`[${source.source_key}] stock-only: no campaign to refresh.`)
    return
  }

  console.log(`[${source.source_key}] stock-only refresh for price tables ${externalIds.join(', ')}`)
  const syncRunId = await createSyncRun(source.id)

  try {
    const { productMap, variantMap, codes } = await getCampaignItems(source.id, externalIds)

    if (codes.length === 0) {
      console.warn(`[${source.source_key}] stock-only: no synced products for these tables.`)
      await updateSyncRun(syncRunId, {
        status: 'success',
        finished_at: new Date().toISOString(),
        metadata: { stock_only: true, codes: 0 }
      })
      return
    }

    console.log(`[${source.source_key}] fetching stock for ${codes.length} codes`)
    const stocks = await fetchStocksByCodes(source.sgi_base_url, token, codes)
    const stockSyncResult = await upsertStocks(source.id, stocks, productMap, variantMap, syncRunId)

    await updateSyncRun(syncRunId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      records_received: stocks.length,
      records_upserted: stockSyncResult.changedCurrentRows + stockSyncResult.insertedSnapshots,
      metadata: {
        stock_only: true,
        codes: codes.length,
        stock_rows_changed: stockSyncResult.changedCurrentRows
      }
    })

    console.log(
      `[${source.source_key}] stock-only done: ${codes.length} codes, ${stockSyncResult.changedCurrentRows} quantities updated`
    )
  } catch (error) {
    await updateSyncRun(syncRunId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function getVigenteCampaignExternalIds() {
  const { data, error } = await supabase
    .from('price_tables')
    .select('external_id')
    .lte('validade_inicial', TODAY)
    .gte('validade_final', TODAY)
    .lt('validade_final', CAMPAIGN_END_SENTINEL)

  if (error) {
    throw error
  }

  return [...new Set((data ?? []).map((row) => Number(row.external_id)))]
}

// Load the codes + external_id->db_id maps for a source's products/variants that are
// priced in the given campaign price tables (so we know exactly what to re-read).
async function getCampaignItems(integrationSourceId, externalIds) {
  const productMap = new Map()
  const variantMap = new Map()
  const codes = new Set()

  const { data: tables, error: tablesError } = await supabase
    .from('price_tables')
    .select('id')
    .eq('integration_source_id', integrationSourceId)
    .in('external_id', externalIds)

  if (tablesError) {
    throw tablesError
  }

  const tableIds = (tables ?? []).map((row) => row.id)
  if (tableIds.length === 0) {
    return { productMap, variantMap, codes: [] }
  }

  const productIds = new Set()
  for (const idsChunk of chunk(tableIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('product_prices')
      .select('product_id')
      .in('price_table_id', idsChunk)
    if (error) {
      throw error
    }
    for (const row of data ?? []) {
      productIds.add(row.product_id)
    }
  }

  for (const idsChunk of chunk([...productIds], UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('products')
      .select('id, external_id, codigo')
      .in('id', idsChunk)
    if (error) {
      throw error
    }
    for (const row of data ?? []) {
      productMap.set(Number(row.external_id), row.id)
      if (row.codigo) {
        codes.add(row.codigo)
      }
    }
  }

  const variantIds = new Set()
  for (const idsChunk of chunk(tableIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('product_variant_prices')
      .select('variant_id')
      .in('price_table_id', idsChunk)
    if (error) {
      throw error
    }
    for (const row of data ?? []) {
      variantIds.add(row.variant_id)
    }
  }

  for (const idsChunk of chunk([...variantIds], UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('product_variants')
      .select('id, external_id, codigo')
      .in('id', idsChunk)
    if (error) {
      throw error
    }
    for (const row of data ?? []) {
      variantMap.set(Number(row.external_id), row.id)
      if (row.codigo) {
        codes.add(row.codigo)
      }
    }
  }

  return { productMap, variantMap, codes: [...codes] }
}

async function fetchStocksByCodes(baseUrl, token, codes) {
  const results = []
  const CONCURRENCY = 12

  for (let index = 0; index < codes.length; index += CONCURRENCY) {
    const batch = codes.slice(index, index + CONCURRENCY)
    const responses = await Promise.all(
      batch.map((code) => fetchStockByCode(baseUrl, token, code))
    )
    for (const items of responses) {
      results.push(...items)
    }
  }

  return results
}

async function fetchStockByCode(baseUrl, token, code) {
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
      const json = await response.json()
      return Array.isArray(json.estoques) ? json.estoques : []
    } catch (error) {
      if (attempt === 3) {
        throw new Error(`SGI request failed (estoques, codigo ${code}): ${error.message}`)
      }
    }
  }

  return []
}

async function getIntegrationSources(client, sourceKey) {
  let query = client
    .from('integration_sources')
    .select('id, source_key, name, stock_scope_label, env_token_name, sgi_base_url')
    .eq('is_active', true)
    .order('source_key')

  if (sourceKey) {
    query = query.eq('source_key', sourceKey)
  }

  const { data, error } = await query
  if (error) {
    throw error
  }

  return data ?? []
}

async function createSyncRun(integrationSourceId) {
  const payload = {
    integration_source_id: integrationSourceId,
    sync_type: 'full',
    status: 'running',
    metadata: {}
  }

  const { data, error } = await supabase
    .from('sync_runs')
    .insert(payload)
    .select('id')
    .single()

  if (error) {
    throw error
  }

  return data.id
}

async function updateSyncRun(syncRunId, fields) {
  const { error } = await supabase
    .from('sync_runs')
    .update(fields)
    .eq('id', syncRunId)

  if (error) {
    throw error
  }
}

async function fetchAllPages(baseUrl, endpoint, token, rootKey, extraParams = {}) {
  const results = []
  const seenPageSignatures = new Set()
  const seenItemKeys = new Set()

  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(`${API_PATH}/${endpoint}`, baseUrl)
    url.searchParams.set('token', token)
    url.searchParams.set('page', String(page))
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }

    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    })

    if (!response.ok) {
      throw new Error(`SGI request failed (${endpoint}, page ${page}): ${response.status}`)
    }

    const json = await response.json()
    const items = Array.isArray(json[rootKey]) ? json[rootKey] : []

    if (items.length === 0) {
      break
    }

    const pageItemKeys = items
      .map((item) => getStableItemKey(rootKey, item))
      .filter(Boolean)

    if (pageItemKeys.length > 0) {
      const unseenItems = items.filter((item) => {
        const key = getStableItemKey(rootKey, item)
        if (!key || seenItemKeys.has(key)) {
          return false
        }

        seenItemKeys.add(key)
        return true
      })

      if (unseenItems.length === 0) {
        break
      }

      results.push(...unseenItems)

      if (items.length < PAGE_SIZE) {
        break
      }

      continue
    }

    const firstItemSignature = JSON.stringify(items[0] ?? null)
    const lastItemSignature = JSON.stringify(items.at(-1) ?? null)
    const pageSignature = `${items.length}:${firstItemSignature}:${lastItemSignature}`

    if (seenPageSignatures.has(pageSignature)) {
      break
    }

    seenPageSignatures.add(pageSignature)
    results.push(...items)

    if (items.length < PAGE_SIZE) {
      break
    }
  }

  return results
}

function getStableItemKey(rootKey, item) {
  if (!item || typeof item !== 'object') {
    return null
  }

  if ((rootKey === 'produtos' || rootKey === 'estoques') && item.id) {
    return `${rootKey}:${item.id}`
  }

  if (rootKey === 'precos' && item.tabela_preco?.id) {
    return `${rootKey}:${item.tabela_preco.id}`
  }

  return null
}

async function fetchItemsByCodes(baseUrl, endpoint, token, rootKey, codes, extraParams = {}) {
  const results = []

  for (const code of codes) {
    const url = new URL(`${API_PATH}/${endpoint}`, baseUrl)
    url.searchParams.set('token', token)
    url.searchParams.set('codigo', code)
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }

    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    })

    if (!response.ok) {
      throw new Error(`SGI request failed (${endpoint}, codigo ${code}): ${response.status}`)
    }

    const json = await response.json()
    const items = Array.isArray(json[rootKey]) ? json[rootKey] : []
    results.push(...items)
  }

  return results
}

async function filterProductsByPriceTable(baseUrl, token, priceTableId, products) {
  const matchedProducts = []
  const matchedPriceProducts = []

  for (const product of products) {
    const priceProduct = await fetchPriceProductByCode(
      baseUrl,
      token,
      priceTableId,
      product.codigo
    )

    if (!priceProduct || !hasPositivePrice(priceProduct)) {
      continue
    }

    matchedProducts.push(product)
    matchedPriceProducts.push(priceProduct)
  }

  return {
    products: matchedProducts,
    priceProducts: matchedPriceProducts
  }
}

async function fetchProductsForPriceTable(baseUrl, token, priceTableId, limit) {
  const priceProducts = await fetchPriceTableProducts(baseUrl, token, priceTableId, limit)

  const selectedPriceProducts = limit
    ? priceProducts.slice(0, limit)
    : priceProducts

  // Campaign prices live at the grade (color variant) level, e.g. 3005-1. The catalog
  // must show the parent model (3005) once, with the grades as variants. Group priced
  // rows by parent code (grade "X-N" -> "X") and fetch the PARENT products only.
  const pricedRowsByParent = new Map()
  for (const row of selectedPriceProducts) {
    const parentCode = toParentCode(row.codigo)
    if (!parentCode) {
      continue
    }
    if (!pricedRowsByParent.has(parentCode)) {
      pricedRowsByParent.set(parentCode, [])
    }
    pricedRowsByParent.get(parentCode).push(row)
  }

  const products = await fetchItemsByCodes(
    baseUrl,
    'produtos',
    token,
    'produtos',
    [...pricedRowsByParent.keys()],
    { ativo: 'true' }
  )
  const productByCode = new Map(products.map((item) => [item.codigo, item]))

  const resultPriceProducts = []
  for (const [parentCode, rows] of pricedRowsByParent) {
    const parent = productByCode.get(parentCode)
    if (!parent) {
      continue
    }

    resultPriceProducts.push(...rows)

    // When only the grades are priced (the parent model has no price of its own),
    // synthesize a parent price = cheapest grade, so the model shows in the grid.
    const parentHasOwnPrice = rows.some((row) => row.codigo === parentCode)
    if (!parentHasOwnPrice) {
      const gradePrices = rows
        .map((row) => toNullableNumber(row.preco))
        .filter((value) => value !== null && value > 0)

      if (gradePrices.length > 0) {
        resultPriceProducts.push({
          id: parent.id,
          codigo: parentCode,
          preco: String(Math.min(...gradePrices))
        })
      }
    }
  }

  return {
    products,
    priceProducts: resultPriceProducts
  }
}

// A grade/color SKU is coded as "<parent>-<n>" (e.g. 3005-1). Strip the trailing
// "-<n>" to get the parent model code; codes without that suffix are their own parent.
function toParentCode(codigo) {
  return String(codigo ?? '').replace(/-\d+$/, '')
}

async function fetchPriceTableProducts(baseUrl, token, priceTableId, limit) {
  const results = []
  const seenProductCodes = new Set()
  let nextPage = 1
  let reachedEnd = false

  // The SGI /precos endpoint ignores tabela_preco_id and returns the WHOLE catalog
  // (~20k rows / ~686 pages of 30) with preco=0 for products not in the table. The real
  // campaign members are the ones with preco>0, scattered across all pages — there is no
  // server-side filter, so we must scan every page. To keep it fast we fetch pages in
  // parallel windows instead of one-at-a-time.
  while (!reachedEnd) {
    const pageNumbers = Array.from(
      { length: PRICE_SCAN_CONCURRENCY },
      (_, index) => nextPage + index
    )
    nextPage += PRICE_SCAN_CONCURRENCY

    const pages = await Promise.all(
      pageNumbers.map((page) => fetchPricePage(baseUrl, token, priceTableId, page))
    )

    for (const rawProducts of pages) {
      if (rawProducts.length < PAGE_SIZE) {
        reachedEnd = true
      }

      for (const item of rawProducts) {
        if (!hasPositivePrice(item)) {
          continue
        }

        const key = item?.codigo || item?.id
        if (!key || seenProductCodes.has(key)) {
          continue
        }

        seenProductCodes.add(key)
        results.push(item)
      }
    }

    if (limit && results.length >= limit) {
      return results.slice(0, limit)
    }
  }

  return results
}

async function fetchPricePage(baseUrl, token, priceTableId, page) {
  const url = new URL(`${API_PATH}/precos`, baseUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('tabela_preco_id', String(priceTableId))
  url.searchParams.set('ativo', 'true')
  url.searchParams.set('page', String(page))

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!response.ok) {
        throw new Error(`status ${response.status}`)
      }
      const json = await response.json()
      return (json.precos ?? []).flatMap((entry) => entry.tabela_preco?.produtos ?? [])
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `SGI request failed (precos, tabela_preco_id ${priceTableId}, page ${page}): ${error.message}`
        )
      }
    }
  }

  return []
}

async function fetchVigentePromotionalTables(baseUrl, token) {
  const byId = new Map()

  // 1) The listing endpoint returns a stale snapshot that omits the newest tables.
  const listed = await fetchAllPages(baseUrl, 'precos', token, 'precos', { ativo: 'true' })
  for (const entry of listed) {
    const id = Number(entry.tabela_preco?.id)
    if (Number.isFinite(id) && !byId.has(id)) {
      byId.set(id, entry)
    }
  }

  // 2) Probe ids beyond the highest listed one — direct-by-id is always current, so
  //    this catches campaigns created after the listing snapshot (e.g. 167, 168).
  const maxListed = byId.size ? Math.max(...byId.keys()) : 0
  let consecutiveMisses = 0
  for (let id = maxListed + 1; consecutiveMisses < PROBE_MISS_LIMIT; id += 1) {
    const entry = await tryFetchPriceTableById(baseUrl, token, id)
    if (entry) {
      byId.set(id, entry)
      consecutiveMisses = 0
    } else {
      consecutiveMisses += 1
    }
  }

  const vigentes = [...byId.values()].filter((entry) =>
    isVigentePromotionalTable(entry.tabela_preco)
  )

  // Most recently started first.
  vigentes.sort((left, right) =>
    (parseBrazilianDate(right.tabela_preco.validade_inicial) ?? '').localeCompare(
      parseBrazilianDate(left.tabela_preco.validade_inicial) ?? ''
    )
  )

  return vigentes
}

async function tryFetchPriceTableById(baseUrl, token, priceTableId) {
  const url = new URL(`${API_PATH}/precos`, baseUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('tabela_preco_id', String(priceTableId))
  url.searchParams.set('ativo', 'true')
  url.searchParams.set('page', '1')

  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    return null
  }

  const json = await response.json()
  const table = (json.precos ?? [])[0]
  return table?.tabela_preco?.id ? table : null
}

function isVigentePromotionalTable(tabelaPreco) {
  const start = parseBrazilianDate(tabelaPreco?.validade_inicial)
  const end = parseBrazilianDate(tabelaPreco?.validade_final)

  if (!start || !end) {
    return false
  }

  // Skip the permanent base table (ends on the 9999 sentinel).
  if (end >= CAMPAIGN_END_SENTINEL) {
    return false
  }

  if (start > TODAY || TODAY > end) {
    return false
  }

  // Promotional campaigns run for a bounded, short window and aren't internal/base
  // tables. Internal tables span months/years; real campaigns last days/weeks.
  if (INTERNAL_TABLE_NAME_PATTERN.test(tabelaPreco.descricao ?? '')) {
    return false
  }

  const days =
    (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000
  return Number.isFinite(days) && days >= 0 && days <= MAX_PROMO_DAYS
}

async function fetchTargetPriceTable(baseUrl, token, priceTableId, campaign) {
  const allPriceTables = await fetchAllPages(
    baseUrl,
    'precos',
    token,
    'precos',
    { ativo: 'true' }
  )

  const matchedPriceTables = filterPriceTables(
    allPriceTables,
    priceTableId,
    campaign
  )

  if (matchedPriceTables.length === 0) {
    throw new Error(
      `No price table matched the provided filter.`
    )
  }

  if (matchedPriceTables.length > 1) {
    throw new Error(
      `Multiple price tables matched the filter. Use --price-table-id for an exact table.`
    )
  }

  return matchedPriceTables[0]
}

async function fetchPriceTableById(baseUrl, token, priceTableId) {
  const url = new URL(`${API_PATH}/precos`, baseUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('tabela_preco_id', String(priceTableId))
  url.searchParams.set('ativo', 'true')
  url.searchParams.set('page', '1')

  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  })

  if (!response.ok) {
    throw new Error(
      `SGI request failed (precos, tabela_preco_id ${priceTableId}): ${response.status}`
    )
  }

  const json = await response.json()
  const table = (json.precos ?? [])[0]

  if (!table?.tabela_preco?.id) {
    throw new Error(`Price table ${priceTableId} not found.`)
  }

  return table
}

async function fetchPriceProductByCode(baseUrl, token, priceTableId, code) {
  const url = new URL(`${API_PATH}/precos`, baseUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('tabela_preco_id', String(priceTableId))
  url.searchParams.set('codigo', code)
  url.searchParams.set('ativo', 'true')

  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  })

  if (!response.ok) {
    throw new Error(
      `SGI request failed (precos, tabela_preco_id ${priceTableId}, codigo ${code}): ${response.status}`
    )
  }

  const json = await response.json()
  const priceRows = (json.precos ?? []).flatMap((entry) => entry.tabela_preco?.produtos ?? [])
  return priceRows[0] ?? null
}

async function fetchPriceProductsByCodes(baseUrl, token, priceTableId, codes) {
  const results = []

  for (const code of [...new Set(codes.filter(Boolean))]) {
    const item = await fetchPriceProductByCode(baseUrl, token, priceTableId, code)
    if (item && hasPositivePrice(item)) {
      results.push(item)
    }
  }

  return results
}

function hasPositivePrice(priceProduct) {
  return (toNullableNumber(priceProduct?.preco) ?? 0) > 0
}

function dedupeByKey(items, getKey) {
  const map = new Map()

  for (const item of items) {
    const key = getKey(item)
    if (!key || map.has(key)) {
      continue
    }

    map.set(key, item)
  }

  return [...map.values()]
}

function collectVariantDescriptors(products) {
  const descriptors = []

  for (const product of products) {
    for (const [index, grade] of (product.grades ?? []).entries()) {
      descriptors.push({
        parentExternalId: Number(product.id),
        externalId: Number(grade.id),
        codigo: grade.codigo,
        descricao: grade.descricao,
        sortOrder: index
      })
    }
  }

  return descriptors
}

async function fetchVariantProducts(baseUrl, token, variantDescriptors) {
  const codes = [...new Set(variantDescriptors.map((item) => item.codigo).filter(Boolean))]

  if (codes.length === 0) {
    return []
  }

  return fetchItemsByCodes(baseUrl, 'produtos', token, 'produtos', codes, {
    ativo: 'true'
  })
}

async function upsertProducts(products) {
  const timestamp = new Date().toISOString()
  const rows = products.map((product) => ({
    external_id: Number(product.id),
    codigo: product.codigo,
    descricao: product.descricao,
    descricao_departamento_produto: product.descricao_departamento_produto ?? null,
    descricao_grupo_produto: product.descricao_grupo_produto ?? null,
    descricao_subgrupo_produto: product.descricao_subgrupo_produto ?? null,
    descricao_marca_produto: product.descricao_marca_produto ?? null,
    descricao_unidade_medida: product.descricao_unidade_medida ?? null,
    possui_montagem: product.possui_montagem ?? null,
    informacoes_adicionais_html: product.informacoes_adicionais ?? null,
    designer_produto: product.designer_produto ?? null,
    altura: toNullableNumber(product.altura),
    largura: toNullableNumber(product.largura),
    profundidade: toNullableNumber(product.profundidade),
    peso: toNullableNumber(product.peso),
    peso_liquido: toNullableNumber(product.peso_liquido),
    cubagem: toNullableNumber(product.cubagem),
    diametro: toNullableNumber(product.diametro),
    volume: toNullableInteger(product.volume),
    garantia_meses: toNullableInteger(product.garantia_meses),
    altura_embalagem_cm: toNullableNumber(product.altura_embalagem_cm),
    largura_embalagem_cm: toNullableNumber(product.largura_embalagem_cm),
    comprimento_embalagem_cm: toNullableNumber(product.comprimento_embalagem_cm),
    peso_embalagem_kg: toNullableNumber(product.peso_embalagem_kg),
    tag: product.tag ?? null,
    descricao_ecommerce: product.descricao_ecommerce ?? null,
    raw_payload: product,
    last_seen_at: timestamp
  }))

  for (const chunkRows of chunk(rows, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('products')
      .upsert(chunkRows, { onConflict: 'external_id' })

    if (error) {
      throw error
    }
  }
}

async function getProductsMap(externalIds) {
  const map = new Map()

  for (const idsChunk of chunk(externalIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('products')
      .select('id, external_id, codigo')
      .in('external_id', idsChunk)

    if (error) {
      throw error
    }

    for (const row of data ?? []) {
      map.set(Number(row.external_id), row.id)
    }
  }

  return map
}

async function replaceProductImages(products, productMap) {
  const imageRows = []
  const affectedProductIds = new Set()

  for (const product of products) {
    const productId = productMap.get(Number(product.id))
    if (!productId) {
      continue
    }

    affectedProductIds.add(productId)

    ;(product.imagens ?? []).forEach((image, index) => {
      imageRows.push({
        product_id: productId,
        image_path: toAbsoluteImageUrl(image.path),
        description: image.description ?? null,
        is_primary: Boolean(image.imagem_principal),
        sort_order: index
      })
    })
  }

  const affectedIds = [...affectedProductIds]

  for (const idsChunk of chunk(affectedIds, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_images')
      .delete()
      .in('product_id', idsChunk)

    if (error) {
      throw error
    }
  }

  for (const imageChunk of chunk(imageRows, INSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_images')
      .insert(imageChunk)

    if (error) {
      throw error
    }
  }
}

async function upsertProductVariants(variantProducts, variantDescriptors, productMap) {
  if (variantProducts.length === 0) {
    return
  }

  const timestamp = new Date().toISOString()
  const descriptorMap = new Map(
    variantDescriptors.map((item) => [Number(item.externalId), item])
  )

  const rows = variantProducts
    .map((variantProduct) => {
      const descriptor = descriptorMap.get(Number(variantProduct.id))
      const parentProductId = descriptor
        ? productMap.get(Number(descriptor.parentExternalId))
        : null

      if (!parentProductId) {
        return null
      }

      return {
        parent_product_id: parentProductId,
        external_id: Number(variantProduct.id),
        codigo: variantProduct.codigo,
        descricao: variantProduct.descricao,
        display_label: inferVariantLabel(variantProduct),
        sort_order: descriptor.sortOrder ?? 0,
        raw_payload: variantProduct,
        last_seen_at: timestamp
      }
    })
    .filter(Boolean)

  for (const chunkRows of chunk(rows, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_variants')
      .upsert(chunkRows, { onConflict: 'external_id' })

    if (error) {
      throw error
    }
  }
}

async function getProductVariantsMap(externalIds) {
  const map = new Map()

  for (const idsChunk of chunk(externalIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('product_variants')
      .select('id, external_id, codigo')
      .in('external_id', idsChunk)

    if (error) {
      throw error
    }

    for (const row of data ?? []) {
      map.set(Number(row.external_id), row.id)
    }
  }

  return map
}

async function replaceProductVariantImages(variantProducts, variantMap) {
  const imageRows = []
  const affectedVariantIds = new Set()

  for (const variantProduct of variantProducts) {
    const variantId = variantMap.get(Number(variantProduct.id))
    if (!variantId) {
      continue
    }

    affectedVariantIds.add(variantId)

    ;(variantProduct.imagens ?? []).forEach((image, index) => {
      imageRows.push({
        variant_id: variantId,
        image_path: toAbsoluteImageUrl(image.path),
        description: image.description ?? null,
        is_primary: Boolean(image.imagem_principal),
        sort_order: index
      })
    })
  }

  const affectedIds = [...affectedVariantIds]

  for (const idsChunk of chunk(affectedIds, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_variant_images')
      .delete()
      .in('variant_id', idsChunk)

    if (error) {
      throw error
    }
  }

  for (const imageChunk of chunk(imageRows, INSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_variant_images')
      .insert(imageChunk)

    if (error) {
      throw error
    }
  }
}

async function replaceProductKitItems(products, productMap) {
  const kitRows = []
  const affectedKitIds = new Set()

  for (const product of products) {
    const kitProductId = productMap.get(Number(product.id))
    if (!kitProductId) {
      continue
    }

    affectedKitIds.add(kitProductId)

    ;(product.itens_kit ?? []).forEach((item, index) => {
      const componentProductId = productMap.get(Number(item.id))
      if (!componentProductId) {
        return
      }

      kitRows.push({
        kit_product_id: kitProductId,
        component_product_id: componentProductId,
        component_codigo: item.codigo,
        component_descricao: item.descricao,
        quantity_required: 1,
        sort_order: index
      })
    })
  }

  const affectedIds = [...affectedKitIds]

  for (const idsChunk of chunk(affectedIds, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_kit_items')
      .delete()
      .in('kit_product_id', idsChunk)

    if (error) {
      throw error
    }
  }

  for (const rowsChunk of chunk(kitRows, INSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_kit_items')
      .insert(rowsChunk)

    if (error) {
      throw error
    }
  }
}

async function upsertPriceTablesAndPrices(integrationSourceId, pricesPayload, productMap, variantMap) {
  const priceTableRows = pricesPayload.map((entry) => ({
    integration_source_id: integrationSourceId,
    external_id: Number(entry.tabela_preco.id),
    descricao: entry.tabela_preco.descricao,
    validade_inicial: parseBrazilianDate(entry.tabela_preco.validade_inicial),
    validade_final: parseBrazilianDate(entry.tabela_preco.validade_final),
    raw_payload: entry.tabela_preco
  }))

  for (const chunkRows of chunk(priceTableRows, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('price_tables')
      .upsert(chunkRows, { onConflict: 'integration_source_id,external_id' })

    if (error) {
      throw error
    }
  }

  const priceTableMap = await getPriceTablesMap(integrationSourceId, priceTableRows.map((row) => row.external_id))
  const productPrices = []
  const variantPrices = []

  for (const entry of pricesPayload) {
    const priceTableId = priceTableMap.get(Number(entry.tabela_preco.id))
    if (!priceTableId) {
      continue
    }

    for (const item of entry.tabela_preco.produtos ?? []) {
      const productId = productMap.get(Number(item.id))
      const variantId = variantMap.get(Number(item.id))

      if (productId) {
        productPrices.push({
          product_id: productId,
          price_table_id: priceTableId,
          price_amount: toNullableNumber(item.preco) ?? 0,
          currency_code: 'BRL',
          captured_at: new Date().toISOString()
        })
        continue
      }

      if (!variantId) {
        continue
      }

      variantPrices.push({
        variant_id: variantId,
        price_table_id: priceTableId,
        price_amount: toNullableNumber(item.preco) ?? 0,
        currency_code: 'BRL',
        captured_at: new Date().toISOString()
      })
    }
  }

  // Deduplicate before upserting: Postgres rejects an ON CONFLICT batch that
  // touches the same (product_id, price_table_id) pair twice within one command.
  const dedupedProductPrices = dedupeByKey(
    productPrices,
    (row) => `${row.product_id}:${row.price_table_id}`
  )
  const dedupedVariantPrices = dedupeByKey(
    variantPrices,
    (row) => `${row.variant_id}:${row.price_table_id}`
  )

  for (const chunkRows of chunk(dedupedProductPrices, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_prices')
      .upsert(chunkRows, { onConflict: 'product_id,price_table_id' })

    if (error) {
      throw error
    }
  }

  for (const chunkRows of chunk(dedupedVariantPrices, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_variant_prices')
      .upsert(chunkRows, { onConflict: 'variant_id,price_table_id' })

    if (error) {
      throw error
    }
  }
}

async function getPriceTablesMap(integrationSourceId, externalIds) {
  const map = new Map()

  for (const idsChunk of chunk(externalIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('price_tables')
      .select('id, external_id')
      .eq('integration_source_id', integrationSourceId)
      .in('external_id', idsChunk)

    if (error) {
      throw error
    }

    for (const row of data ?? []) {
      map.set(Number(row.external_id), row.id)
    }
  }

  return map
}

async function upsertStocks(integrationSourceId, stocks, productMap, variantMap, syncRunId) {
  const timestamp = new Date().toISOString()
  const desiredProductRows = []
  const desiredVariantRows = []

  for (const item of stocks) {
    const productId = productMap.get(Number(item.id))
    const variantId = variantMap.get(Number(item.id))
    const quantity = toNullableNumber(item.quantidade_disponivel) ?? 0

    if (productId) {
      desiredProductRows.push({
        product_id: productId,
        integration_source_id: integrationSourceId,
        quantity_available: quantity,
        captured_at: timestamp
      })
      continue
    }

    if (!variantId) {
      continue
    }

    desiredVariantRows.push({
      variant_id: variantId,
      integration_source_id: integrationSourceId,
      quantity_available: quantity,
      captured_at: timestamp
    })
  }

  const existingRowsMap = await getCurrentStockMap(
    integrationSourceId,
    desiredProductRows.map((row) => row.product_id)
  )
  const existingVariantRowsMap = await getCurrentVariantStockMap(
    integrationSourceId,
    desiredVariantRows.map((row) => row.variant_id)
  )

  const currentProductRows = []
  const snapshotProductRows = []
  const currentVariantRows = []
  const snapshotVariantRows = []

  for (const row of desiredProductRows) {
    const existingRow = existingRowsMap.get(row.product_id)
    if (
      existingRow &&
      Number(existingRow.quantity_available) === Number(row.quantity_available)
    ) {
      continue
    }

    currentProductRows.push(row)

    snapshotProductRows.push({
      product_id: row.product_id,
      integration_source_id: row.integration_source_id,
      sync_run_id: syncRunId,
      quantity_available: row.quantity_available,
      captured_at: timestamp
    })
  }

  for (const row of desiredVariantRows) {
    const existingRow = existingVariantRowsMap.get(row.variant_id)
    if (
      existingRow &&
      Number(existingRow.quantity_available) === Number(row.quantity_available)
    ) {
      continue
    }

    currentVariantRows.push(row)

    snapshotVariantRows.push({
      variant_id: row.variant_id,
      integration_source_id: row.integration_source_id,
      sync_run_id: syncRunId,
      quantity_available: row.quantity_available,
      captured_at: timestamp
    })
  }

  for (const chunkRows of chunk(currentProductRows, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_stock_current')
      .upsert(chunkRows, { onConflict: 'product_id,integration_source_id' })

    if (error) {
      throw error
    }
  }

  for (const chunkRows of chunk(snapshotProductRows, INSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_stock_snapshots')
      .insert(chunkRows)

    if (error) {
      throw error
    }
  }

  for (const chunkRows of chunk(currentVariantRows, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_variant_stock_current')
      .upsert(chunkRows, { onConflict: 'variant_id,integration_source_id' })

    if (error) {
      throw error
    }
  }

  for (const chunkRows of chunk(snapshotVariantRows, INSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('product_variant_stock_snapshots')
      .insert(chunkRows)

    if (error) {
      throw error
    }
  }

  return {
    changedCurrentRows: currentProductRows.length + currentVariantRows.length,
    insertedSnapshots: snapshotProductRows.length + snapshotVariantRows.length
  }
}

async function getCurrentStockMap(integrationSourceId, productIds) {
  const map = new Map()

  for (const idsChunk of chunk(productIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('product_stock_current')
      .select('product_id, quantity_available')
      .eq('integration_source_id', integrationSourceId)
      .in('product_id', idsChunk)

    if (error) {
      throw error
    }

    for (const row of data ?? []) {
      map.set(row.product_id, row)
    }
  }

  return map
}

async function getCurrentVariantStockMap(integrationSourceId, variantIds) {
  const map = new Map()

  for (const idsChunk of chunk(variantIds, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('product_variant_stock_current')
      .select('variant_id, quantity_available')
      .eq('integration_source_id', integrationSourceId)
      .in('variant_id', idsChunk)

    if (error) {
      throw error
    }

    for (const row of data ?? []) {
      map.set(row.variant_id, row)
    }
  }

  return map
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const normalized = String(value).replace(',', '.').trim()
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function toNullableInteger(value) {
  const parsed = toNullableNumber(value)
  return parsed === null ? null : Math.trunc(parsed)
}

function parseBrazilianDate(value) {
  if (!value) {
    return null
  }

  const [day, month, year] = String(value).split('/')
  if (!day || !month || !year) {
    return null
  }

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function toAbsoluteImageUrl(path) {
  if (!path) {
    return null
  }

  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path
  }

  return new URL(path, process.env.SGI_BASE_URL).toString()
}

function inferVariantLabel(variantProduct) {
  const firstImageDescription = variantProduct.imagens?.[0]?.description

  if (firstImageDescription) {
    return cleanupVariantLabel(firstImageDescription)
  }

  return cleanupVariantLabel(variantProduct.codigo)
}

function cleanupVariantLabel(value) {
  return String(value)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\(\d+\)\s*$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function chunk(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function filterPriceTables(priceTables, priceTableId, campaign) {
  const normalizedCampaign = campaign?.trim().toLowerCase()

  return priceTables.filter((entry) => {
    const matchesId = priceTableId
      ? Number(entry.tabela_preco.id) === Number(priceTableId)
      : true
    const matchesCampaign = normalizedCampaign
      ? String(entry.tabela_preco.descricao).toLowerCase().includes(normalizedCampaign)
      : true

    return matchesId && matchesCampaign
  })
}

function getArgValue(prefix) {
  return process.argv.find((arg) => arg.startsWith(`${prefix}=`))?.split('=')[1]
}

function getSelectedCodes() {
  const codesArg = getArgValue('--codes')
  const codesFileArg = getArgValue('--codes-file')

  if (codesArg) {
    return codesArg
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  if (codesFileArg) {
    const filePath = resolve(process.cwd(), codesFileArg)
    if (!existsSync(filePath)) {
      throw new Error(`Codes file not found: ${codesFileArg}`)
    }

    return readFileSync(filePath, 'utf8')
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

function loadEnvFile(fileName) {
  const filePath = resolve(process.cwd(), fileName)
  if (!existsSync(filePath)) {
    return
  }

  const contents = readFileSync(filePath, 'utf8')
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}
