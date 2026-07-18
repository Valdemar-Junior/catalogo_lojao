// The SGI price-table API has no "type" field, so a promotional campaign is told
// apart from base/internal tables by two signals:
//   1. a bounded, short validity window (real campaigns last days/weeks, internal
//      and base tables span months to centuries), and
//   2. a description that isn't one of the internal/base tables.
const MAX_PROMO_DAYS = 120
const INTERNAL_NAME_PATTERN = /INTERNA|CUSTO|E-?COM+ERCE|TABELA DE PRE[CÇ]OS/i

export function isPromotionalCampaign(
  descricao: string | null,
  validadeInicial: string | null,
  validadeFinal: string | null
): boolean {
  if (INTERNAL_NAME_PATTERN.test(descricao ?? '')) {
    return false
  }

  if (!validadeInicial || !validadeFinal) {
    return false
  }

  const days =
    (new Date(validadeFinal).getTime() - new Date(validadeInicial).getTime()) /
    86_400_000

  return Number.isFinite(days) && days >= 0 && days <= MAX_PROMO_DAYS
}
