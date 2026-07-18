# Supabase

As migrations SQL do projeto ficam em `supabase/migrations`.

Ordem atual:

1. `20260617101000_initial_catalog_schema.sql`

O schema foi pensado para:

- manter o cadastro mestre de produtos uma unica vez
- guardar estoque por origem de integracao/token
- manter historico de snapshots de saldo
- permitir multiplas tabelas de preco por origem
- registrar execucoes de sincronizacao

Observacoes importantes:

- Os tokens SGI nao foram gravados nas migrations.
- A tabela `integration_sources` guarda apenas o nome da variavel de ambiente (`env_token_name`) esperada pela rotina de sincronizacao.
- As imagens devem usar a URL absoluta montada a partir de `sgi_base_url + image_path`.
