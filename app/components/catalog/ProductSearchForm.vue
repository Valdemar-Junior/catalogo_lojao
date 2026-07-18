<script setup lang="ts">
const model = defineModel<string>({ required: true })

defineProps<{
  pending?: boolean
}>()

const emit = defineEmits<{
  submit: []
  clear: []
}>()
</script>

<template>
  <form
    class="glass-card flex items-center gap-3 rounded-[24px] p-3"
    @submit.prevent="emit('submit')"
  >
    <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface-muted)] text-[var(--ink-soft)]">
      <span class="i-lucide-search h-5 w-5" aria-hidden="true" />
      <span class="sr-only">Buscar</span>
    </div>

    <input
      v-model="model"
      type="search"
      placeholder="Buscar por nome ou codigo..."
      class="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]"
    >

    <button
      v-if="model"
      type="button"
      class="rounded-2xl border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-soft)]"
      @click="emit('clear')"
    >
      Limpar
    </button>

    <button
      type="submit"
      class="rounded-2xl bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--brand-strong)] disabled:cursor-not-allowed disabled:opacity-60"
      :disabled="pending"
    >
      {{ pending ? 'Buscando...' : 'Buscar' }}
    </button>
  </form>
</template>
