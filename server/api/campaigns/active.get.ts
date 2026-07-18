import { getSupabaseAdmin } from '../../utils/supabase-admin'
import { isPromotionalCampaign } from '../../utils/campaigns'

export default defineEventHandler(async (event) => {
  const supabase = getSupabaseAdmin()
  const query = getQuery(event)

  // `today` override (YYYY-MM-DD) lets the store preview a given date; defaults to now.
  const today =
    typeof query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.today)
      ? query.today
      : new Date().toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('price_tables')
    .select('external_id, descricao, validade_inicial, validade_final')
    .lte('validade_inicial', today)
    .gte('validade_final', today)
    .order('validade_inicial', { ascending: false })

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message
    })
  }

  // One row per external_id (a table exists per source); keep promotional ones only.
  const seen = new Set<number>()
  const campaigns = []

  for (const row of data ?? []) {
    if (seen.has(row.external_id)) {
      continue
    }

    if (!isPromotionalCampaign(row.descricao, row.validade_inicial, row.validade_final)) {
      continue
    }

    seen.add(row.external_id)
    campaigns.push({
      externalId: row.external_id,
      descricao: row.descricao,
      validadeInicial: row.validade_inicial,
      validadeFinal: row.validade_final
    })
  }

  return { today, campaigns }
})
