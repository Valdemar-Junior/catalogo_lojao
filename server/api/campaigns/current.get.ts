import { normalizeProductRecord } from '../../utils/catalog'
import { getKitComponentProductIds, getKitComponentsMap } from '../../utils/kit-products'
import { getSupabaseAdmin } from '../../utils/supabase-admin'

const PRODUCT_SELECT = `
        price_amount,
        products!inner (
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
        ),
        price_tables!inner (
          external_id
        )
      `

type CampaignRow = {
  external_id: number
  descricao: string | null
  validade_inicial: string | null
  validade_final: string | null
}

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdmin()
  const query = getQuery(event)
  const priceTableId = Number(query.priceTableId)

  // The campaign is chosen by the caller (the front-end picks from /campaigns/active).
  const campaign = priceTableId
    ? await findCampaignByExternalId(supabase, priceTableId)
    : null

  if (!campaign) {
    // No campaign selected / found — the front-end renders an empty state.
    return {
      active: false,
      campaign: null,
      items: []
    }
  }

  const { data, error } = await supabase
    .from('product_prices')
    .select(PRODUCT_SELECT)
    .eq('price_tables.external_id', campaign.external_id)
    .gt('price_amount', 0)
    .order('price_amount', { ascending: false })

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message
    })
  }

  const dedupedProductMap = new Map<string, any>()

  for (const row of data ?? []) {
    const product = row.products
    if (!product?.id) {
      continue
    }

    if (!dedupedProductMap.has(product.id)) {
      dedupedProductMap.set(product.id, product)
    }
  }

  const productRows = [...dedupedProductMap.values()]
  const hiddenComponentIds = new Set(await getKitComponentProductIds(supabase))
  const visibleProductRows = productRows.filter((product: any) => !hiddenComponentIds.has(product.id))
  const kitComponentsMap = await getKitComponentsMap(
    supabase,
    visibleProductRows.map((product: any) => product.id)
  )

  for (const product of visibleProductRows) {
    product.kit_components = kitComponentsMap.get(product.id) ?? []
  }

  const items = visibleProductRows.map((product: any) => normalizeProductRecord(product))

  return {
    active: true,
    campaign: {
      externalId: campaign.external_id,
      descricao: campaign.descricao,
      validadeInicial: campaign.validade_inicial,
      validadeFinal: campaign.validade_final
    },
    items
  }
})

async function findCampaignByExternalId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  externalId: number
): Promise<CampaignRow | null> {
  const { data, error } = await supabase
    .from('price_tables')
    .select('external_id, descricao, validade_inicial, validade_final')
    .eq('external_id', externalId)
    .limit(1)
    .maybeSingle()

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message
    })
  }

  return (data as CampaignRow) ?? null
}
