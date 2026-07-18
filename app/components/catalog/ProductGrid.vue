<script setup lang="ts">
import CatalogProductCard from '~/components/catalog/ProductCard.vue'

defineProps<{
  title: string
  products: Array<any>
  emptyMessage: string
}>()
</script>

<template>
  <section class="space-y-5">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold text-[var(--ink)]">
          {{ title }}
        </h2>
        <p class="text-sm text-[var(--ink-soft)]">
          {{ products.length }} produtos
        </p>
      </div>
    </div>

    <div
      v-if="products.length"
      class="grid grid-cols-2 gap-4 lg:grid-cols-4"
    >
      <CatalogProductCard
        v-for="product in products"
        :key="product.codigo"
        :product="product"
      />
    </div>

    <div
      v-else
      class="glass-card rounded-[28px] px-6 py-12 text-center text-sm text-[var(--ink-soft)]"
    >
      {{ emptyMessage }}
    </div>
  </section>
</template>
