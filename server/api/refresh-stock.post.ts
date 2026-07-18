import { refreshCampaignStock, getCampaignStockAgeMs } from '../utils/stock-refresh'

// Manual "Atualizar estoque" button and the scheduled 30-min job both POST here.
// A short cooldown stops repeated clicks from hammering the SGI API.
const COOLDOWN_MS = 60_000

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const body = await readBody(event).catch(() => ({}))
  const rawId = Number(query.priceTableId ?? (body as any)?.priceTableId)
  const externalIds = Number.isFinite(rawId) && rawId > 0 ? [rawId] : undefined

  if (externalIds) {
    const ageMs = await getCampaignStockAgeMs(externalIds)
    if (ageMs !== null && ageMs < COOLDOWN_MS) {
      return {
        refreshed: false,
        throttled: true,
        updated: 0,
        secondsAgo: Math.round(ageMs / 1000)
      }
    }
  }

  const result = await refreshCampaignStock(externalIds)
  return { ...result, throttled: false }
})
