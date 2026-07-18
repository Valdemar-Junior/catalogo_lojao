<script setup lang="ts">
type ProductCardPrice = {
  amount: number
}

type ProductCardStock = {
  total: number
}

defineProps<{
  product: {
    codigo: string
    descricao: string
    primaryImage: null | { url: string, description?: string | null }
    prices: ProductCardPrice[]
    stock: ProductCardStock
    marca?: string | null
  }
}>()

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return 'Sob consulta'
  }

  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value)
}
</script>

<template>
  <NuxtLink
    :to="`/produtos/${product.codigo}`"
    class="group glass-card flex h-full flex-col overflow-hidden rounded-[28px] p-3 transition duration-200 hover:-translate-y-1 hover:shadow-[0_22px_50px_rgba(44,29,16,0.14)]"
  >
    <div class="overflow-hidden rounded-[22px] bg-[#f5efe6]">
      <img
        v-if="product.primaryImage?.url"
        :src="product.primaryImage.url"
        :alt="product.primaryImage.description || product.descricao"
        class="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.03]"
        loading="lazy"
      >
      <div
        v-else
        class="flex aspect-[4/3] items-center justify-center bg-[var(--surface-muted)] text-center text-sm text-[var(--ink-soft)]"
      >
        Sem imagem
      </div>
    </div>

    <div class="flex flex-1 flex-col gap-3 px-2 pb-2 pt-4">
      <div class="space-y-2">
        <div class="text-xs font-medium uppercase tracking-[0.18em] text-[var(--ink-soft)]">
          Cód: {{ product.codigo }}
        </div>
        <h2 class="line-clamp-3 text-sm font-semibold leading-5 text-[var(--ink)] sm:text-base">
          {{ product.descricao }}
        </h2>
        <p
          v-if="product.marca"
          class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]"
        >
          {{ product.marca }}
        </p>
      </div>

      <div class="mt-auto flex items-end justify-between gap-3">
        <div class="rounded-full bg-[#ebf7f1] px-3 py-1 text-sm font-semibold text-[var(--success)]">
          {{ product.stock.total }} un.
        </div>

        <div class="text-right">
          <div class="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
            Preço
          </div>
          <div class="text-lg font-semibold text-[var(--accent)]">
            {{ formatCurrency(product.prices[0]?.amount) }}
          </div>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
