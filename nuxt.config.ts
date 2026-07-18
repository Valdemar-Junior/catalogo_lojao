// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/supabase'],
  supabase: {
    redirect: false
  },
  runtimeConfig: {
    sgiBaseUrl: process.env.SGI_BASE_URL,
    sgiTokenAssu: process.env.SGI_TOKEN_ASSU,
    sgiTokenDeposito: process.env.SGI_TOKEN_DEPOSITO,
    sgiTokenMossoro: process.env.SGI_TOKEN_MOSSORO,
    public: {
      sgiBaseUrl: process.env.SGI_BASE_URL
    }
  }
})
