import { getSupabaseAdmin } from '../utils/supabase-admin'

export default defineEventHandler(async () => {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('branches')
    .select(`
      id,
      slug,
      name,
      integration_sources (
        id,
        source_key,
        name,
        stock_scope_label,
        is_active
      )
    `)
    .eq('is_active', true)
    .order('name')

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message
    })
  }

  return {
    branches: (data ?? []).map((branch) => ({
      id: branch.id,
      slug: branch.slug,
      name: branch.name,
      sources: (branch.integration_sources ?? []).map((source) => ({
        id: source.id,
        sourceKey: source.source_key,
        name: source.name,
        stockScopeLabel: source.stock_scope_label,
        isActive: source.is_active
      }))
    }))
  }
})
