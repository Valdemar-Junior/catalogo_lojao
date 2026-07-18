import type { SupabaseClient } from '@supabase/supabase-js'

export async function getKitComponentProductIds(
  supabase: SupabaseClient,
  kitProductIds?: string[]
) {
  let query = supabase
    .from('product_kit_items')
    .select('component_product_id')

  if (kitProductIds?.length) {
    query = query.in('kit_product_id', kitProductIds)
  }

  const { data, error } = await query

  if (error) {
    throw error
  }

  return [...new Set((data ?? []).map((row) => row.component_product_id))]
}

export async function getKitComponentsMap(
  supabase: SupabaseClient,
  kitProductIds: string[]
) {
  if (kitProductIds.length === 0) {
    return new Map()
  }

  const { data: kitRows, error: kitError } = await supabase
    .from('product_kit_items')
    .select('id, kit_product_id, component_product_id, component_codigo, component_descricao, quantity_required, sort_order')
    .in('kit_product_id', kitProductIds)
    .order('sort_order')

  if (kitError) {
    throw kitError
  }

  const componentIds = [...new Set((kitRows ?? []).map((row) => row.component_product_id))]

  const { data: componentStocks, error: stockError } = await supabase
    .from('product_stock_current')
    .select(
      `
        product_id,
        quantity_available,
        captured_at,
        integration_sources (
          source_key,
          name,
          stock_scope_label,
          branches (
            slug,
            name
          )
        )
      `
    )
    .in('product_id', componentIds)

  if (stockError) {
    throw stockError
  }

  const stockMap = new Map<string, any[]>()

  for (const stockRow of componentStocks ?? []) {
    const rows = stockMap.get(stockRow.product_id) ?? []
    rows.push(stockRow)
    stockMap.set(stockRow.product_id, rows)
  }

  const kitMap = new Map<string, any[]>()

  for (const row of kitRows ?? []) {
    const items = kitMap.get(row.kit_product_id) ?? []
    items.push({
      ...row,
      component_product: {
        product_stock_current: stockMap.get(row.component_product_id) ?? []
      }
    })
    kitMap.set(row.kit_product_id, items)
  }

  return kitMap
}
