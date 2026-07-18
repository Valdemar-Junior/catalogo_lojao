type CatalogStockRow = {
  quantity_available: number | string
  captured_at: string
  integration_sources: null | {
    source_key: string
    name: string
    stock_scope_label: string
    branches: null | {
      slug: string
      name: string
    }
  }
}

type CatalogPriceRow = {
  price_amount: number | string
  price_tables: null | {
    external_id: number
    descricao: string
    validade_inicial: string | null
    validade_final: string | null
    integration_sources: null | {
      source_key: string
      name: string
      branches: null | {
        slug: string
        name: string
      }
    }
  }
}

type CatalogVariantRow = {
  id: string
  external_id: number
  codigo: string
  descricao: string
  display_label: string | null
  sort_order: number
  product_variant_images?: any[]
  product_variant_stock_current?: CatalogStockRow[]
  product_variant_prices?: CatalogPriceRow[]
}

export function normalizeProductRecord(product: any) {
  const baseStocks = normalizeStocks(product.product_stock_current ?? [])
  const prices = normalizePrices(product.product_prices ?? [])
  const kitComponents = normalizeKitComponents(product.kit_components ?? [])
  const variants = (product.product_variants ?? [])
    .map(normalizeVariantRecord)
    .sort((left: any, right: any) => left.sortOrder - right.sortOrder)

  // Stock priority: kit components < color variants (grades) < the product's own stock.
  // A model with grades has no stock of its own — its availability is the sum of its
  // grades' stock, so the parent card/total reflects what's actually in the colors.
  const stocks = kitComponents.length > 0
    ? computeKitStocks(kitComponents)
    : variants.length > 0
      ? aggregateVariantStocks(variants)
      : baseStocks
  const primaryImage =
    (product.product_images ?? []).find((image: any) => image.is_primary) ??
    product.product_images?.[0] ??
    null

  return {
    id: product.id,
    externalId: product.external_id,
    codigo: product.codigo,
    descricao: product.descricao,
    descricaoEcommerce: product.descricao_ecommerce,
    marca: product.descricao_marca_produto,
    departamento: product.descricao_departamento_produto,
    grupo: product.descricao_grupo_produto,
    subgrupo: product.descricao_subgrupo_produto,
    unidadeMedida: product.descricao_unidade_medida,
    possuiMontagem: product.possui_montagem,
    garantiaMeses: product.garantia_meses,
    peso: product.peso,
    pesoLiquido: product.peso_liquido,
    altura: product.altura,
    largura: product.largura,
    profundidade: product.profundidade,
    informacoesAdicionaisHtml: product.informacoes_adicionais_html,
    images: (product.product_images ?? []).map((image: any) => ({
      id: image.id,
      url: image.image_path,
      description: image.description,
      isPrimary: image.is_primary,
      sortOrder: image.sort_order
    })),
    primaryImage: primaryImage
      ? {
          id: primaryImage.id,
          url: primaryImage.image_path,
          description: primaryImage.description
        }
      : null,
    stock: {
      total: stocks.reduce((sum, item) => sum + item.quantityAvailable, 0),
      bySource: stocks
    },
    prices,
    isKit: kitComponents.length > 0,
    kitComponents,
    variants
  }
}

// Sum grade (variant) stock into a single per-source list, so the parent model shows
// the combined availability of all its colors.
export function aggregateVariantStocks(variants: any[]) {
  const sourceMap = new Map<string, any>()

  for (const variant of variants) {
    for (const stock of variant.stock.bySource) {
      const sourceKey = `${stock.sourceKey}:${stock.branch?.slug ?? 'sem-filial'}`
      const existing = sourceMap.get(sourceKey)

      if (existing) {
        existing.quantityAvailable += stock.quantityAvailable
      } else {
        sourceMap.set(sourceKey, { ...stock })
      }
    }
  }

  return [...sourceMap.values()]
}

// Variant labels come from inconsistent SGI image descriptions. Normalize casing and
// fall back to the codigo (not a digits-only "1133 1" scrap) when there's no real name.
function formatVariantLabel(displayLabel: string | null, codigo: string) {
  const raw = (displayLabel ?? '').trim()
  if (raw === '' || /^[\d\s]+$/.test(raw)) {
    return codigo
  }
  return raw.toLowerCase().replace(/\b\p{L}/gu, (char) => char.toUpperCase())
}

export function normalizeVariantRecord(variant: CatalogVariantRow) {
  const stocks = normalizeStocks(variant.product_variant_stock_current ?? [])
  const prices = normalizePrices(variant.product_variant_prices ?? [])
  const primaryImage =
    (variant.product_variant_images ?? []).find((image: any) => image.is_primary) ??
    variant.product_variant_images?.[0] ??
    null

  return {
    id: variant.id,
    externalId: variant.external_id,
    codigo: variant.codigo,
    descricao: variant.descricao,
    label: formatVariantLabel(variant.display_label, variant.codigo),
    sortOrder: variant.sort_order ?? 0,
    images: (variant.product_variant_images ?? []).map((image: any) => ({
      id: image.id,
      url: image.image_path,
      description: image.description,
      isPrimary: image.is_primary,
      sortOrder: image.sort_order
    })),
    primaryImage: primaryImage
      ? {
          id: primaryImage.id,
          url: primaryImage.image_path,
          description: primaryImage.description
        }
      : null,
    stock: {
      total: stocks.reduce((sum, item) => sum + item.quantityAvailable, 0),
      bySource: stocks
    },
    prices
  }
}

export function normalizeKitComponents(rows: any[]) {
  return rows.map((row) => {
    const component = row.component_product ?? null
    const stocks = normalizeStocks(component?.product_stock_current ?? [])

    return {
      id: row.id,
      sortOrder: row.sort_order ?? 0,
      quantityRequired: Number(row.quantity_required ?? 1),
      componentProductId: row.component_product_id,
      codigo: row.component_codigo,
      descricao: row.component_descricao,
      stock: {
        total: stocks.reduce((sum, item) => sum + item.quantityAvailable, 0),
        bySource: stocks
      }
    }
  })
}

export function computeKitStocks(kitComponents: any[]) {
  if (kitComponents.length === 0) {
    return []
  }

  const sourceMap = new Map<string, any>()

  for (const component of kitComponents) {
    for (const stock of component.stock.bySource) {
      const sourceKey = `${stock.sourceKey}:${stock.branch?.slug ?? 'sem-filial'}`
      if (!sourceMap.has(sourceKey)) {
        sourceMap.set(sourceKey, stock)
      }
    }
  }

  return [...sourceMap.entries()].map(([sourceKey, stock]) => {
    const quantities = kitComponents.map((component) => {
      const componentStock = component.stock.bySource.find(
        (item: any) =>
          `${item.sourceKey}:${item.branch?.slug ?? 'sem-filial'}` === sourceKey
      )

      return componentStock ? componentStock.quantityAvailable : 0
    })

    return {
      sourceKey: stock.sourceKey,
      sourceName: stock.sourceName,
      stockScopeLabel: stock.stockScopeLabel,
      branch: stock.branch,
      quantityAvailable: Math.min(...quantities),
      capturedAt: stock.capturedAt
    }
  })
}

export function normalizeStocks(rows: CatalogStockRow[]) {
  return rows
    .filter((row) => row.integration_sources)
    .map((row) => ({
      sourceKey: row.integration_sources!.source_key,
      sourceName: row.integration_sources!.name,
      stockScopeLabel: row.integration_sources!.stock_scope_label,
      branch: row.integration_sources!.branches
        ? {
            slug: row.integration_sources!.branches.slug,
            name: row.integration_sources!.branches.name
          }
        : null,
      quantityAvailable: Number(row.quantity_available ?? 0),
      capturedAt: row.captured_at
    }))
}

export function normalizePrices(rows: CatalogPriceRow[]) {
  return rows
    .filter((row) => row.price_tables)
    .map((row) => ({
      sourceKey: row.price_tables!.integration_sources?.source_key ?? null,
      sourceName: row.price_tables!.integration_sources?.name ?? null,
      branch: row.price_tables!.integration_sources?.branches
        ? {
            slug: row.price_tables!.integration_sources.branches.slug,
            name: row.price_tables!.integration_sources.branches.name
          }
        : null,
      externalId: row.price_tables!.external_id,
      descricao: row.price_tables!.descricao,
      validadeInicial: row.price_tables!.validade_inicial,
      validadeFinal: row.price_tables!.validade_final,
      amount: Number(row.price_amount ?? 0)
    }))
}

export function toBooleanQuery(value: unknown) {
  if (value === 'true' || value === true) {
    return true
  }

  if (value === 'false' || value === false) {
    return false
  }

  return null
}
