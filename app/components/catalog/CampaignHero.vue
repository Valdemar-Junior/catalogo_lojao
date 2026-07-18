<script setup lang="ts">
defineProps<{
  campaignName: string
  itemCount: number
}>()
</script>

<template>
  <section
    class="overflow-hidden rounded-[28px] bg-gradient-to-br from-[#0f7f70] via-[#14756b] to-[#1c9a77] p-6 text-white shadow-[0_24px_60px_rgba(20,117,107,0.28)]"
  >
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-4">
        <div class="inline-flex items-center gap-2 rounded-full bg-white/12 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]">
          <span class="inline-block h-2 w-2 rounded-full bg-[#ffd18f]" />
          Campanha vigente
        </div>

        <div class="space-y-2">
          <h1 class="max-w-[18ch] text-2xl font-semibold leading-tight sm:text-4xl">
            {{ campaignName }}
          </h1>
          <p class="max-w-[46ch] text-sm leading-6 text-white/80 sm:text-base">
            Consulte rapidamente codigo, estoque, preco, imagens e detalhes dos produtos da campanha ativa.
          </p>
        </div>
      </div>

      <div class="rounded-2xl bg-white/12 px-4 py-3 text-right">
        <div class="text-xs uppercase tracking-[0.18em] text-white/70">
          Itens carregados
        </div>
        <div class="text-3xl font-semibold">
          {{ itemCount }}
        </div>
      </div>
    </div>
  </section>
</template>
