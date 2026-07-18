<script setup lang="ts">
const route = useRoute()
const codigo = computed(() => String(route.params.codigo))

const { data, pending } = await useFetch(() => `/api/products/${codigo.value}`)

const product = computed(() => data.value?.item)
const selectedVariantCode = ref<string | null>(null)
const selectedImageId = ref<string | null>(null)

const selectedVariant = computed(() => {
  if (!product.value?.variants?.length || !selectedVariantCode.value) {
    return null
  }

  return product.value.variants.find((variant: any) => variant.codigo === selectedVariantCode.value) ?? null
})

const activeItem = computed(() => selectedVariant.value ?? product.value)

const displayedImage = computed(() => {
  if (!activeItem.value) {
    return null
  }

  if (selectedImageId.value) {
    return activeItem.value.images?.find((image: any) => image.id === selectedImageId.value) ?? activeItem.value.primaryImage
  }

  return activeItem.value.primaryImage
})

watch(
  product,
  (nextProduct) => {
    selectedVariantCode.value = nextProduct?.variants?.[0]?.codigo ?? null
  },
  { immediate: true }
)

watch(
  activeItem,
  (nextItem) => {
    selectedImageId.value = nextItem?.primaryImage?.id ?? nextItem?.images?.[0]?.id ?? null
  },
  { immediate: true }
)

function selectImage(imageId: string) {
  selectedImageId.value = imageId
}

function selectVariant(codigo: string) {
  selectedVariantCode.value = codigo
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return 'Sob consulta'
  }

  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value)
}

useHead(() => ({
  title: product.value?.descricao
    ? `${product.value.descricao} | Catalogo Lojao`
    : 'Produto | Catalogo Lojao'
}))
</script>

<template>
  <main class="page-shell pb-16 pt-6">
    <div class="container-mobile space-y-6">
      <NuxtLink
        to="/"
        class="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/70 px-4 py-2 text-sm text-[var(--ink-soft)]"
      >
        Voltar ao catalogo
      </NuxtLink>

      <div
        v-if="pending"
        class="glass-card rounded-[28px] px-6 py-12 text-center text-sm text-[var(--ink-soft)]"
      >
        Carregando produto...
      </div>

      <div
        v-else-if="product"
        class="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]"
      >
        <section class="space-y-4">
          <div class="glass-card overflow-hidden rounded-[32px] p-4">
            <img
              v-if="displayedImage?.url"
              :src="displayedImage.url"
              :alt="displayedImage.description || activeItem?.descricao || product.descricao"
              class="aspect-[4/3] w-full rounded-[24px] object-cover"
            >
            <div
              v-else
              class="flex aspect-[4/3] items-center justify-center rounded-[24px] bg-[var(--surface-muted)] text-[var(--ink-soft)]"
            >
              Sem imagem principal
            </div>
          </div>

          <div
            v-if="activeItem?.images?.length"
            class="grid grid-cols-3 gap-3 sm:grid-cols-4"
          >
            <button
              v-for="image in activeItem.images"
              :key="image.id"
              type="button"
              class="glass-card overflow-hidden rounded-[20px] p-2 text-left transition"
              :class="image.id === selectedImageId ? 'ring-2 ring-[var(--brand)]' : 'opacity-80 hover:opacity-100'"
              @click="selectImage(image.id)"
            >
              <img
                :src="image.url"
                :alt="image.description || activeItem?.descricao || product.descricao"
                class="aspect-square w-full rounded-2xl object-cover"
                loading="lazy"
              >
            </button>
          </div>
        </section>

        <section class="space-y-4">
          <div class="glass-card rounded-[32px] p-6">
            <div class="space-y-3">
              <div class="text-xs font-medium uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                Cod. {{ product.codigo }}
              </div>
              <h1 class="text-2xl font-semibold leading-tight text-[var(--ink)]">
                {{ product.descricao }}
              </h1>
              <p
                v-if="product.descricaoEcommerce"
                class="text-sm leading-6 text-[var(--ink-soft)]"
              >
                {{ product.descricaoEcommerce }}
              </p>
            </div>

            <div
              v-if="product.variants?.length"
              class="mt-6 space-y-2"
            >
              <div class="block text-xs font-medium uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                Variacao ({{ product.variants.length }})
              </div>
              <div class="flex flex-wrap gap-3">
                <button
                  v-for="variant in product.variants"
                  :key="variant.codigo"
                  type="button"
                  class="flex w-[84px] flex-col items-center gap-1 rounded-[18px] border p-2 text-center transition"
                  :class="variant.codigo === selectedVariantCode
                    ? 'border-[var(--brand)] ring-2 ring-[var(--brand)]'
                    : 'border-[var(--line)] opacity-90 hover:border-[var(--brand)] hover:opacity-100'"
                  :title="variant.label"
                  @click="selectVariant(variant.codigo)"
                >
                  <img
                    v-if="variant.primaryImage?.url"
                    :src="variant.primaryImage.url"
                    :alt="variant.codigo"
                    class="aspect-square w-full rounded-[12px] object-cover"
                    loading="lazy"
                  >
                  <div
                    v-else
                    class="flex aspect-square w-full items-center justify-center rounded-[12px] bg-[var(--surface-muted)] text-[10px] text-[var(--ink-soft)]"
                  >
                    sem foto
                  </div>
                  <span class="text-xs font-medium text-[var(--ink)]">
                    {{ variant.codigo }}
                  </span>
                </button>
              </div>
            </div>

            <div class="mt-6 grid grid-cols-2 gap-3">
              <div class="rounded-[24px] bg-[var(--surface-muted)] p-4">
                <div class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                  Estoque total
                </div>
                <div class="mt-2 text-2xl font-semibold text-[var(--success)]">
                  {{ activeItem?.stock?.total ?? 0 }}
                </div>
                <div
                  v-if="product.variants?.length"
                  class="mt-1 text-xs text-[var(--ink-soft)]"
                >
                  Todas as variacoes: {{ product.stock?.total ?? 0 }}
                </div>
              </div>

              <div class="rounded-[24px] bg-[var(--surface-muted)] p-4">
                <div class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                  Preco atual
                </div>
                <div class="mt-2 text-xl font-semibold text-[var(--accent)]">
                  {{ formatCurrency(activeItem?.prices?.[0]?.amount) }}
                </div>
              </div>
            </div>
          </div>

          <div class="glass-card rounded-[32px] p-6">
            <h2 class="text-lg font-semibold text-[var(--ink)]">
              Estoque por origem
            </h2>
            <div class="mt-4 space-y-3">
              <div
                v-for="stock in activeItem?.stock?.bySource || []"
                :key="`${stock.sourceKey}-${stock.branch?.slug || 'sem-filial'}`"
                class="rounded-[22px] border border-[var(--line)] bg-white/70 p-4"
              >
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium text-[var(--ink)]">
                      {{ stock.sourceName }}
                    </div>
                    <div class="text-sm text-[var(--ink-soft)]">
                      {{ stock.stockScopeLabel }}
                    </div>
                  </div>
                  <div class="text-right">
                    <div class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                      Disponivel
                    </div>
                    <div class="text-lg font-semibold text-[var(--success)]">
                      {{ stock.quantityAvailable }}
                    </div>
                  </div>
                </div>
              </div>

              <div
                v-if="!(activeItem?.stock?.bySource?.length)"
                class="text-sm text-[var(--ink-soft)]"
              >
                Nenhum estoque sincronizado para este item.
              </div>
            </div>
          </div>

          <div
            v-if="product.isKit && product.kitComponents?.length"
            class="glass-card rounded-[32px] p-6"
          >
            <h2 class="text-lg font-semibold text-[var(--ink)]">
              Itens do kit
            </h2>
            <div class="mt-4 space-y-3">
              <div
                v-for="component in product.kitComponents"
                :key="component.id"
                class="rounded-[22px] border border-[var(--line)] bg-white/70 p-4"
              >
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <div class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                      Cod. {{ component.codigo }}
                    </div>
                    <div class="mt-1 font-medium text-[var(--ink)]">
                      {{ component.descricao }}
                    </div>
                  </div>
                  <div class="text-right">
                    <div class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                      Estoque
                    </div>
                    <div class="text-lg font-semibold text-[var(--success)]">
                      {{ component.stock.total }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="glass-card rounded-[32px] p-6">
            <h2 class="text-lg font-semibold text-[var(--ink)]">
              Precos vinculados
            </h2>
            <div class="mt-4 space-y-3">
              <div
                v-for="price in activeItem?.prices || []"
                :key="`${price.externalId}-${price.sourceKey}`"
                class="rounded-[22px] border border-[var(--line)] bg-white/70 p-4"
              >
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium text-[var(--ink)]">
                      {{ price.descricao }}
                    </div>
                    <div class="text-sm text-[var(--ink-soft)]">
                      {{ price.sourceName || 'Sem origem' }}
                    </div>
                  </div>
                  <div class="text-right text-lg font-semibold text-[var(--accent)]">
                    {{ formatCurrency(price.amount) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="product.informacoesAdicionaisHtml"
            class="glass-card rounded-[32px] p-6"
          >
            <h2 class="text-lg font-semibold text-[var(--ink)]">
              Informacoes adicionais
            </h2>
            <div
              class="prose prose-sm mt-4 max-w-none text-[var(--ink-soft)]"
              v-html="product.informacoesAdicionaisHtml"
            />
          </div>
        </section>
      </div>
    </div>
  </main>
</template>
