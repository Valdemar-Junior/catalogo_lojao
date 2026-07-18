create table if not exists public.product_kit_items (
  id uuid primary key default gen_random_uuid(),
  kit_product_id uuid not null references public.products(id) on delete cascade,
  component_product_id uuid not null references public.products(id) on delete cascade,
  component_codigo text not null,
  component_descricao text not null,
  quantity_required numeric(14, 3) not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (kit_product_id, component_product_id)
);

create index if not exists idx_product_kit_items_kit_product_id
  on public.product_kit_items (kit_product_id, sort_order);

create index if not exists idx_product_kit_items_component_product_id
  on public.product_kit_items (component_product_id);

drop trigger if exists set_updated_at_product_kit_items on public.product_kit_items;
create trigger set_updated_at_product_kit_items
before update on public.product_kit_items
for each row
execute function public.set_updated_at();
