import { normalizeProductRecord } from '../../utils/catalog'
import { getKitComponentsMap } from '../../utils/kit-products'
import { getSupabaseAdmin } from '../../utils/supabase-admin'

export default defineEventHandler(async (event) => {
  const codigo = getRouterParam(event, 'codigo')
  if (!codigo) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing product codigo.'
    })
  }

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
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
        product_variants (
          id,
          external_id,
          codigo,
          descricao,
          display_label,
          sort_order,
          product_variant_images (
            id,
            image_path,
            description,
            is_primary,
            sort_order
          ),
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
          ),
          product_variant_prices (
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
          )
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
        )
      `
    )
    .eq('codigo', codigo)
    .maybeSingle()

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message
    })
  }

  if (!data) {
    throw createError({
      statusCode: 404,
      statusMessage: `Product not found for codigo "${codigo}".`
    })
  }

  const kitComponentsMap = await getKitComponentsMap(supabase, [data.id])
  data.kit_components = kitComponentsMap.get(data.id) ?? []

  return {
    item: normalizeProductRecord(data)
  }
})
