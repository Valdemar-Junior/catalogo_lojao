create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint branches_slug_lowercase check (slug = lower(slug))
);

create table if not exists public.integration_sources (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  source_key text not null unique,
  name text not null,
  stock_scope_label text not null,
  env_token_name text not null unique,
  sgi_base_url text not null,
  sync_products_enabled boolean not null default true,
  sync_prices_enabled boolean not null default true,
  sync_stocks_enabled boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint integration_sources_source_key_lowercase check (source_key = lower(source_key))
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  external_id bigint not null unique,
  codigo text not null unique,
  descricao text not null,
  descricao_departamento_produto text,
  descricao_grupo_produto text,
  descricao_subgrupo_produto text,
  descricao_marca_produto text,
  descricao_unidade_medida text,
  possui_montagem boolean,
  informacoes_adicionais_html text,
  designer_produto text,
  altura numeric(12, 3),
  largura numeric(12, 3),
  profundidade numeric(12, 3),
  peso numeric(12, 3),
  peso_liquido numeric(12, 3),
  cubagem numeric(12, 3),
  diametro numeric(12, 3),
  volume integer,
  garantia_meses integer,
  altura_embalagem_cm numeric(12, 3),
  largura_embalagem_cm numeric(12, 3),
  comprimento_embalagem_cm numeric(12, 3),
  peso_embalagem_kg numeric(12, 3),
  tag text,
  descricao_ecommerce text,
  raw_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  image_path text not null,
  description text,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, image_path)
);

create table if not exists public.price_tables (
  id uuid primary key default gen_random_uuid(),
  integration_source_id uuid not null references public.integration_sources(id) on delete cascade,
  external_id bigint not null,
  descricao text not null,
  validade_inicial date,
  validade_final date,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (integration_source_id, external_id)
);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  integration_source_id uuid references public.integration_sources(id) on delete set null,
  sync_type text not null,
  status text not null default 'running',
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  records_received integer not null default 0,
  records_upserted integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint sync_runs_type_check check (sync_type in ('products', 'prices', 'stocks', 'full')),
  constraint sync_runs_status_check check (status in ('running', 'success', 'partial_success', 'failed'))
);

create table if not exists public.product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  price_table_id uuid not null references public.price_tables(id) on delete cascade,
  price_amount numeric(14, 2) not null default 0,
  currency_code text not null default 'BRL',
  captured_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, price_table_id)
);

create table if not exists public.product_stock_current (
  product_id uuid not null references public.products(id) on delete cascade,
  integration_source_id uuid not null references public.integration_sources(id) on delete cascade,
  quantity_available numeric(14, 3) not null default 0,
  captured_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (product_id, integration_source_id)
);

create table if not exists public.product_stock_snapshots (
  id bigserial primary key,
  product_id uuid not null references public.products(id) on delete cascade,
  integration_source_id uuid not null references public.integration_sources(id) on delete cascade,
  sync_run_id uuid references public.sync_runs(id) on delete set null,
  quantity_available numeric(14, 3) not null default 0,
  captured_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_integration_sources_branch_id
  on public.integration_sources (branch_id);

create index if not exists idx_products_codigo
  on public.products (codigo);

create index if not exists idx_products_departamento_grupo_subgrupo
  on public.products (descricao_departamento_produto, descricao_grupo_produto, descricao_subgrupo_produto);

create index if not exists idx_product_images_product_id
  on public.product_images (product_id);

create unique index if not exists uq_product_images_primary
  on public.product_images (product_id)
  where is_primary = true;

create index if not exists idx_price_tables_integration_source_id
  on public.price_tables (integration_source_id);

create index if not exists idx_product_prices_product_id
  on public.product_prices (product_id);

create index if not exists idx_product_prices_price_table_id
  on public.product_prices (price_table_id);

create index if not exists idx_product_stock_current_integration_source_id
  on public.product_stock_current (integration_source_id);

create index if not exists idx_product_stock_snapshots_product_source_captured
  on public.product_stock_snapshots (product_id, integration_source_id, captured_at desc);

create index if not exists idx_sync_runs_source_type_started
  on public.sync_runs (integration_source_id, sync_type, started_at desc);

create trigger set_updated_at_branches
before update on public.branches
for each row
execute function public.set_updated_at();

create trigger set_updated_at_integration_sources
before update on public.integration_sources
for each row
execute function public.set_updated_at();

create trigger set_updated_at_products
before update on public.products
for each row
execute function public.set_updated_at();

create trigger set_updated_at_product_images
before update on public.product_images
for each row
execute function public.set_updated_at();

create trigger set_updated_at_price_tables
before update on public.price_tables
for each row
execute function public.set_updated_at();

create trigger set_updated_at_sync_runs
before update on public.sync_runs
for each row
execute function public.set_updated_at();

create trigger set_updated_at_product_prices
before update on public.product_prices
for each row
execute function public.set_updated_at();

create trigger set_updated_at_product_stock_current
before update on public.product_stock_current
for each row
execute function public.set_updated_at();

insert into public.branches (slug, name, notes)
values
  ('atacado-loja-assu', 'ATACADO LOJA ASSU', 'Escopo de estoque configurado na integracao SGI.'),
  ('atacado-deposito', 'ATACADO DEPOSITO', 'Escopo de estoque configurado na integracao SGI.'),
  ('atacado-loja-mossoro', 'ATACADO LOJA MOSSORO', 'Escopo de estoque configurado na integracao SGI.')
on conflict (slug) do update
set
  name = excluded.name,
  notes = excluded.notes,
  updated_at = timezone('utc', now());

insert into public.integration_sources (
  branch_id,
  source_key,
  name,
  stock_scope_label,
  env_token_name,
  sgi_base_url
)
select
  b.id,
  v.source_key,
  v.name,
  v.stock_scope_label,
  v.env_token_name,
  'https://smart.sgisistemas.com.br'
from public.branches b
join (
  values
    ('atacado-loja-assu', 'assu', 'ATACADO LOJA ASSU', 'ATACADO LOJA ASSU', 'SGI_TOKEN_ASSU'),
    ('atacado-deposito', 'deposito', 'ATACADO DEPOSITO', 'ATACADO DEPOSITO', 'SGI_TOKEN_DEPOSITO'),
    ('atacado-loja-mossoro', 'mossoro', 'ATACADO LOJA MOSSORO', 'LOJA MOSSORO, LOJA MOSSORO PARTAGE', 'SGI_TOKEN_MOSSORO')
) as v(branch_slug, source_key, name, stock_scope_label, env_token_name)
  on b.slug = v.branch_slug
on conflict (source_key) do update
set
  branch_id = excluded.branch_id,
  name = excluded.name,
  stock_scope_label = excluded.stock_scope_label,
  env_token_name = excluded.env_token_name,
  sgi_base_url = excluded.sgi_base_url,
  updated_at = timezone('utc', now());

create or replace view public.catalog_product_stock_summary as
select
  p.id as product_id,
  p.external_id,
  p.codigo,
  p.descricao,
  coalesce(sum(psc.quantity_available), 0) as total_quantity_available,
  jsonb_agg(
    jsonb_build_object(
      'integration_source_id', isrc.id,
      'source_key', isrc.source_key,
      'source_name', isrc.name,
      'stock_scope_label', isrc.stock_scope_label,
      'quantity_available', psc.quantity_available,
      'captured_at', psc.captured_at
    )
    order by isrc.name
  ) filter (where isrc.id is not null) as stock_by_source
from public.products p
left join public.product_stock_current psc
  on psc.product_id = p.id
left join public.integration_sources isrc
  on isrc.id = psc.integration_source_id
group by p.id, p.external_id, p.codigo, p.descricao;
