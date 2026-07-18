import { normalizeProductRecord, toBooleanQuery } from '../utils/catalog'
import { getKitComponentProductIds, getKitComponentsMap } from '../utils/kit-products'
import { getSupabaseAdmin } from '../utils/supabase-admin'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdmin()
  const query = getQuery(event)

  const page = Math.max(Number(query.page ?? 1) || 1, 1)
  const pageSize = Math.min(Math.max(Number(query.pageSize ?? 24) || 24, 1), 100)
  const search = String(query.search ?? '').trim()
  const branch = String(query.branch ?? '').trim()
  const source = String(query.source ?? '').trim()
  const onlyInStock = toBooleanQuery(query.onlyInStock)

  let dbQuery = supabase
    .from('products')
    .select(
      `
        id,
        external_id,
        codigo,
        descricao,
        descricao_ecommerce,
        descricao_marca_produto,
        descricao_departamento_produto,
        descricao_grupo_produto,
        descricao_subgrupo_produto,
        descricao_unidade_medida,
        possui_montagem,
        garantia_meses,
        peso,
        peso_liquido,
        altura,
        largura,
        profundidade,
        informacoes_adicionais_html,
        product_images (
          id,
          image_path,
          description,
          is_primary,
          sort_order
        ),
        product_stock_current (
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
        ),
        product_prices (
          price_amount,
          price_tables (
            external_id,
            descricao,
            validade_inicial,
            validade_final,
            integration_sources (
              source_key,
              name,
              branches (
                slug,
                name
              )
            )
          )
        ),
        product_variants (
          id,
          external_id,
          codigo,
          descricao,
          display_label,
          sort_order,
          product_variant_stock_current (
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
          )
        )
      `,
      { count: 'exact' }
    )
    .order('descricao')

  if (search) {
    dbQuery = dbQuery.or(
      `codigo.ilike.%${search}%,descricao.ilike.%${search}%,descricao_ecommerce.ilike.%${search}%`
    )
  }

  const { data, error, count } = await dbQuery.range(
    (page - 1) * pageSize,
    page * pageSize - 1
  )

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message
    })
  }

  const productRows = data ?? []
  const hiddenComponentIds = new Set(await getKitComponentProductIds(supabase))
  const visibleProductRows = productRows.filter((product) => !hiddenComponentIds.has(product.id))
  const kitComponentsMap = await getKitComponentsMap(
    supabase,
    visibleProductRows.map((product) => product.id)
  )

  for (const product of visibleProductRows) {
    product.kit_components = kitComponentsMap.get(product.id) ?? []
  }

  let products = visibleProductRows.map(normalizeProductRecord)

  if (branch) {
    products = products.filter((product) =>
      product.stock.bySource.some((stock: any) => stock.branch?.slug === branch) ||
      product.prices.some((price: any) => price.branch?.slug === branch)
    )
  }

  if (source) {
    products = products.filter((product) =>
      product.stock.bySource.some((stock: any) => stock.sourceKey === source) ||
      product.prices.some((price: any) => price.sourceKey === source)
    )
  }

  if (onlyInStock === true) {
    products = products.filter((product) => product.stock.total > 0)
  }

  return {
    page,
    pageSize,
    total: products.length,
    items: products
  }
})
