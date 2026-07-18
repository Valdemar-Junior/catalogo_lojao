create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  parent_product_id uuid not null references public.products(id) on delete cascade,
  external_id bigint not null unique,
  codigo text not null unique,
  descricao text not null,
  display_label text,
  sort_order integer not null default 0,
  raw_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.product_variant_images (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  image_path text not null,
  description text,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (variant_id, image_path)
);

create table if not exists public.product_variant_prices (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  price_table_id uuid not null references public.price_tables(id) on delete cascade,
  price_amount numeric(14, 2) not null default 0,
  currency_code text not null default 'BRL',
  captured_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (variant_id, price_table_id)
);

create table if not exists public.product_variant_stock_current (
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  integration_source_id uuid not null references public.integration_sources(id) on delete cascade,
  quantity_available numeric(14, 3) not null default 0,
  captured_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (variant_id, integration_source_id)
);

create table if not exists public.product_variant_stock_snapshots (
  id bigserial primary key,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  integration_source_id uuid not null references public.integration_sources(id) on delete cascade,
  sync_run_id uuid references public.sync_runs(id) on delete set null,
  quantity_available numeric(14, 3) not null default 0,
  captured_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_product_variants_parent_product_id
  on public.product_variants (parent_product_id, sort_order);

create index if not exists idx_product_variants_codigo
  on public.product_variants (codigo);

create index if not exists idx_product_variant_images_variant_id
  on public.product_variant_images (variant_id);

create unique index if not exists uq_product_variant_images_primary
  on public.product_variant_images (variant_id)
  where is_primary = true;

create index if not exists idx_product_variant_prices_variant_id
  on public.product_variant_prices (variant_id);

create index if not exists idx_product_variant_prices_price_table_id
  on public.product_variant_prices (price_table_id);

create index if not exists idx_product_variant_stock_current_source_id
  on public.product_variant_stock_current (integration_source_id);

create index if not exists idx_product_variant_stock_snapshots_variant_source_captured
  on public.product_variant_stock_snapshots (variant_id, integration_source_id, captured_at desc);

drop trigger if exists set_updated_at_product_variants on public.product_variants;
create trigger set_updated_at_product_variants
before update on public.product_variants
for each row
execute function public.set_updated_at();

drop trigger if exists set_updated_at_product_variant_images on public.product_variant_images;
create trigger set_updated_at_product_variant_images
before update on public.product_variant_images
for each row
execute function public.set_updated_at();

drop trigger if exists set_updated_at_product_variant_prices on public.product_variant_prices;
create trigger set_updated_at_product_variant_prices
before update on public.product_variant_prices
for each row
execute function public.set_updated_at();

drop trigger if exists set_updated_at_product_variant_stock_current on public.product_variant_stock_current;
create trigger set_updated_at_product_variant_stock_current
before update on public.product_variant_stock_current
for each row
execute function public.set_updated_at();
