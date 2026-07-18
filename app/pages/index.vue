<script setup lang="ts">
import CatalogCampaignHero from '~/components/catalog/CampaignHero.vue'
import CatalogProductGrid from '~/components/catalog/ProductGrid.vue'
import CatalogProductSearchForm from '~/components/catalog/ProductSearchForm.vue'

const route = useRoute()
const searchTerm = ref('')
const submittedSearch = ref('')

// Optional ?today=YYYY-MM-DD lets the store preview which campaigns are vigente
// on a given date; otherwise the server uses the real current date.
const previewToday = computed(() =>
  typeof route.query.today === 'string' ? route.query.today : undefined
)

// Promotional campaigns vigente right now — the visitor picks which one to browse.
const { data: activeData } = await useFetch('/api/campaigns/active', {
  query: computed(() => ({ today: previewToday.value }))
})

const campaigns = computed(() => activeData.value?.campaigns ?? [])
const hasActiveCampaign = computed(() => campaigns.value.length > 0)

const selectedCampaignId = ref<number | null>(campaigns.value[0]?.externalId ?? null)

watch(
  campaigns,
  (list) => {
    const stillValid = list.some((item) => item.externalId === selectedCampaignId.value)
    if (!stillValid) {
      selectedCampaignId.value = list[0]?.externalId ?? null
    }
  },
  { immediate: true }
)

const selectedCampaign = computed(() =>
  campaigns.value.find((item) => item.externalId === selectedCampaignId.value) ?? null
)

const {
  data: campaignData,
  pending: campaignPending,
  refresh: refreshCampaignData
} = await useFetch('/api/campaigns/current', {
  query: computed(() => ({ priceTableId: selectedCampaignId.value ?? undefined }))
})

const refreshing = ref(false)
const refreshMessage = ref('')

async function refreshStock() {
  if (refreshing.value || !selectedCampaignId.value) {
    return
  }

  refreshing.value = true
  refreshMessage.value = ''
  try {
    const result = await $fetch<{ throttled?: boolean; secondsAgo?: number }>(
      '/api/refresh-stock',
      { method: 'POST', query: { priceTableId: selectedCampaignId.value } }
    )
    await refreshCampaignData()
    refreshMessage.value = result?.throttled
      ? `Estoque já atualizado há ${result.secondsAgo ?? 0}s.`
      : 'Estoque atualizado.'
  } catch {
    refreshMessage.value = 'Não foi possível atualizar agora.'
  } finally {
    refreshing.value = false
  }
}

const {
  data: searchData,
  pending: searchPending,
  refresh: refreshSearch
} = await useFetch('/api/products', {
  query: computed(() => ({
    search: submittedSearch.value || undefined,
    pageSize: submittedSearch.value ? 24 : undefined
  })),
  immediate: false
})

async function handleSubmit() {
  submittedSearch.value = searchTerm.value.trim()

  if (submittedSearch.value) {
    await refreshSearch()
  }
}

function clearSearch() {
  searchTerm.value = ''
  submittedSearch.value = ''
  searchData.value = null
}

function selectCampaign(externalId: number) {
  submittedSearch.value = ''
  searchTerm.value = ''
  selectedCampaignId.value = externalId
}

const displayedProducts = computed(() => {
  if (submittedSearch.value) {
    return searchData.value?.items ?? []
  }

  return campaignData.value?.items ?? []
})

const heroName = computed(() => {
  if (!hasActiveCampaign.value) {
    return 'Nenhuma campanha ativa'
  }

  return selectedCampaign.value?.descricao || 'Campanha vigente'
})

const currentTitle = computed(() => {
  if (submittedSearch.value) {
    return `Resultados para "${submittedSearch.value}"`
  }

  return selectedCampaign.value?.descricao || 'Catalogo da campanha'
})

const emptyMessage = computed(() => {
  if (submittedSearch.value) {
    return 'Nenhum produto encontrado para essa busca.'
  }

  if (!hasActiveCampaign.value) {
    return 'Nenhuma campanha ativa no momento. Use a busca para consultar produtos por codigo.'
  }

  return 'Nenhum produto encontrado nesta campanha.'
})

function formatValidade(campaign: { validadeInicial?: string | null; validadeFinal?: string | null }) {
  const format = (value?: string | null) => {
    if (!value) {
      return ''
    }
    const [year, month, day] = value.split('-')
    return `${day}/${month}/${year}`
  }

  const start = format(campaign.validadeInicial)
  const end = format(campaign.validadeFinal)
  return start && end ? `${start} a ${end}` : ''
}

useHead({
  title: 'Catalogo Lojao'
})
</script>

<template>
  <main class="page-shell pb-16 pt-6">
    <div class="container-mobile space-y-6">
      <CatalogCampaignHero
        :campaign-name="heroName"
        :item-count="campaignData?.items?.length || 0"
      />

      <div
        v-if="hasActiveCampaign"
        class="flex flex-wrap items-center gap-3"
      >
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-[var(--stroke)] bg-white px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:border-[var(--brand)] disabled:opacity-60"
          :disabled="refreshing"
          @click="refreshStock"
        >
          {{ refreshing ? 'Atualizando estoque...' : 'Atualizar estoque' }}
        </button>
        <span
          v-if="refreshMessage"
          class="text-xs text-[var(--ink-soft)]"
        >
          {{ refreshMessage }}
        </span>
      </div>

      <div
        v-if="campaigns.length > 1"
        class="glass-card rounded-[28px] px-4 py-4"
      >
        <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Campanhas vigentes
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="campaign in campaigns"
            :key="campaign.externalId"
            type="button"
            class="rounded-full border px-4 py-2 text-sm transition"
            :class="campaign.externalId === selectedCampaignId
              ? 'border-transparent bg-[var(--brand)] text-white'
              : 'border-[var(--stroke)] text-[var(--ink)] hover:border-[var(--brand)]'"
            @click="selectCampaign(campaign.externalId)"
          >
            {{ campaign.descricao }}
          </button>
        </div>
        <p
          v-if="selectedCampaign && formatValidade(selectedCampaign)"
          class="mt-3 text-xs text-[var(--ink-soft)]"
        >
          Válida: {{ formatValidade(selectedCampaign) }}
        </p>
      </div>

      <CatalogProductSearchForm
        v-model="searchTerm"
        :pending="searchPending"
        @submit="handleSubmit"
        @clear="clearSearch"
      />

      <CatalogProductGrid
        :title="currentTitle"
        :products="displayedProducts"
        :empty-message="emptyMessage"
      />

      <div
        v-if="campaignPending && !displayedProducts.length"
        class="glass-card rounded-[28px] px-6 py-10 text-center text-sm text-[var(--ink-soft)]"
      >
        Carregando produtos...
      </div>
    </div>
  </main>
</template>
