-- SmartBuzz fresh Supabase schema
-- Run this in a new Supabase project's SQL editor.
-- No Edge Functions are required. Transaction-sensitive actions are handled
-- by Postgres RPC functions: receive_stock() and create_invoice().

create extension if not exists pgcrypto;

-- =========================
-- Helpers
-- =========================
create or replace function public.set_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =========================
-- Core tables
-- =========================
create table if not exists public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  name text not null default 'My Business',
  gstin text,
  phone text,
  email text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  low_stock_threshold integer not null default 10 check (low_stock_threshold > 0),
  default_gst numeric(5,2) not null default 12 check (default_gst >= 0),
  default_unit text not null default 'pcs',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  sku text,
  size text,
  category text not null default 'General',
  unit text not null default 'pcs',
  stock_qty integer not null default 0 check (stock_qty >= 0),
  selling_price numeric(12,2) not null default 0 check (selling_price >= 0),
  purchase_price numeric(12,2) not null default 0 check (purchase_price >= 0),
  mrp numeric(12,2) not null default 0 check (mrp >= 0),
  gst_rate numeric(5,2) not null default 12 check (gst_rate >= 0),
  hsn text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, sku)
);


create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  stock_qty integer not null default 0 check (stock_qty >= 0),
  selling_price numeric(12,2) not null default 0 check (selling_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, name)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  phone text,
  email text,
  gstin text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete set null,
  movement_type text not null check (movement_type in ('receive', 'sale', 'adjustment')),
  quantity integer not null check (quantity > 0),
  source text,
  notes text,
  received_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists public.invoice_counters (
  user_id uuid primary key,
  next_number integer not null default 1 check (next_number > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  invoice_seq integer not null,
  invoice_no text not null,
  customer_id uuid references public.customers(id) on delete set null,
  invoice_date date not null default current_date,
  invoice_type text not null default 'tax_invoice',
  payment_mode text not null default 'Cash',
  subtotal numeric(12,2) not null default 0,
  gst_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, invoice_seq),
  unique(user_id, invoice_no)
);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.product_variants(id),
  product_name text not null,
  variant_name text,
  hsn text,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  gst_rate numeric(5,2) not null default 0 check (gst_rate >= 0),
  line_subtotal numeric(12,2) not null,
  line_gst numeric(12,2) not null,
  line_total numeric(12,2) not null,
  created_at timestamptz not null default now()
);

-- =========================
-- Triggers
-- =========================
do $$
declare
  t text;
begin
  foreach t in array array[
    'business_profiles',
    'business_settings',
    'products',
    'product_variants',
    'customers',
    'stock_movements',
    'invoices',
    'invoice_items'
  ] loop
    execute format('drop trigger if exists set_%I_user_id on public.%I', t, t);
    execute format('create trigger set_%I_user_id before insert on public.%I for each row execute function public.set_user_id()', t, t);
  end loop;

  foreach t in array array[
    'business_profiles',
    'business_settings',
    'products',
    'product_variants',
    'customers',
    'invoices'
  ] loop
    execute format('drop trigger if exists touch_%I_updated_at on public.%I', t, t);
    execute format('create trigger touch_%I_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- =========================
-- Owner / Employee mapping (DB-level)
-- =========================
create table if not exists public.employee_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  employee_user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'employee' check (role in ('employee')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id, employee_user_id)
);

-- updated_at trigger for employee_profiles
alter table public.employee_profiles enable row level security;
create or replace function public.touch_updated_at_employee_profiles()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_employee_profiles_updated_at on public.employee_profiles;
create trigger touch_employee_profiles_updated_at
before update on public.employee_profiles
for each row execute function public.touch_updated_at_employee_profiles();

-- Resolve the "owner_user_id" for the current session.
-- Returns NULL for owners that are not mapped (i.e., owner is owner_user_id).
create or replace function public.owner_for_current_user()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
begin
  if v_user is null then
    return null;
  end if;

  -- If user is mapped as an employee, return the linked owner
  select owner_user_id into v_owner
  from public.employee_profiles
  where employee_user_id = v_user;

  return v_owner;
end;
$$;

-- Owner policies can be expressed as: effective_owner_id = coalesce(owner_for_current_user(), auth.uid())
create or replace function public.effective_owner_id()
returns uuid
language sql
security definer
set search_path = public
as $$
  select coalesce(public.owner_for_current_user(), auth.uid());
$$;

-- =========================
-- RLS
-- =========================
alter table public.business_profiles enable row level security;
alter table public.business_settings enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.customers enable row level security;
alter table public.stock_movements enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;

-- employee_profiles RLS
-- Owners can see/manage their linked employees. Employees can only see their own mapping.
do $$
declare
begin
  drop policy if exists employee_profiles_select on public.employee_profiles;
  drop policy if exists employee_profiles_insert on public.employee_profiles;
  drop policy if exists employee_profiles_update on public.employee_profiles;
  drop policy if exists employee_profiles_delete on public.employee_profiles;

  create policy employee_profiles_select on public.employee_profiles
    for select using (owner_user_id = auth.uid() or employee_user_id = auth.uid());

  create policy employee_profiles_insert on public.employee_profiles
    for insert with check (owner_user_id = auth.uid());

  create policy employee_profiles_update on public.employee_profiles
    for update using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

  create policy employee_profiles_delete on public.employee_profiles
    for delete using (owner_user_id = auth.uid());
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'business_profiles',
    'business_settings',
    'products',
    'product_variants',
    'customers',
    'stock_movements',
    'invoices',
    'invoice_items'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    -- Effective owner means: if user is mapped employee -> operate on owner's rows
    execute format('create policy %I on public.%I for select using (user_id = public.effective_owner_id())', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert with check (user_id = public.effective_owner_id())', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update using (user_id = public.effective_owner_id()) with check (user_id = public.effective_owner_id())', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete using (user_id = public.effective_owner_id())', t || '_delete_own', t);
  end loop;
end $$;

drop policy if exists invoice_counters_select_own on public.invoice_counters;
drop policy if exists invoice_counters_insert_own on public.invoice_counters;
drop policy if exists invoice_counters_update_own on public.invoice_counters;
create policy invoice_counters_select_own on public.invoice_counters for select using (user_id = public.effective_owner_id());
create policy invoice_counters_insert_own on public.invoice_counters for insert with check (user_id = public.effective_owner_id());
create policy invoice_counters_update_own on public.invoice_counters for update using (user_id = public.effective_owner_id()) with check (user_id = public.effective_owner_id());


-- =========================
-- Indexes
-- =========================
create index if not exists products_user_category_idx on public.products(user_id, category);
create index if not exists variants_product_idx on public.product_variants(product_id);
create index if not exists customers_user_name_idx on public.customers(user_id, name);
create index if not exists stock_user_date_idx on public.stock_movements(user_id, received_date desc);
create index if not exists invoices_user_date_idx on public.invoices(user_id, invoice_date desc);
create index if not exists invoice_items_invoice_idx on public.invoice_items(invoice_id);

-- =========================
-- RPC: receive_stock
-- =========================
create or replace function public.receive_stock(
  p_product_id uuid,
  p_variant_id uuid,
  p_quantity integer,
  p_source text default null,
  p_notes text default null,
  p_received_date date default current_date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_product products%rowtype;
  v_variant product_variants%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  -- Employees execute on behalf of their linked owner
  v_user := public.effective_owner_id();
  if v_user is null then
    raise exception 'No owner mapping for current user';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select * into v_product
  from public.products
  where id = p_product_id and user_id = v_user
  for update;

  if not found then
    raise exception 'Product not found';
  end if;

  if p_variant_id is not null then
    select * into v_variant
    from public.product_variants
    where id = p_variant_id and product_id = p_product_id and user_id = v_user
    for update;

    if not found then
      raise exception 'Variant not found';
    end if;

    update public.product_variants
    set stock_qty = stock_qty + p_quantity
    where id = p_variant_id;
  end if;

  update public.products
  set stock_qty = stock_qty + p_quantity
  where id = p_product_id;

  insert into public.stock_movements (
    user_id, product_id, variant_id, movement_type, quantity, source, notes, received_date
  )
  values (
    v_user, p_product_id, p_variant_id, 'receive', p_quantity, nullif(p_source, ''), nullif(p_notes, ''), coalesce(p_received_date, current_date)
  );
end;
$$;

-- =========================
-- RPC: create_invoice
-- =========================
create or replace function public.create_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_invoice_type text,
  p_payment_mode text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_invoice_id uuid;
  v_seq integer;
  v_invoice_no text;
  v_item jsonb;
  v_product products%rowtype;
  v_variant product_variants%rowtype;
  v_product_id uuid;
  v_variant_id uuid;
  v_qty integer;
  v_price numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_gst numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_line_subtotal numeric(12,2);
  v_line_gst numeric(12,2);
  v_line_total numeric(12,2);
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  -- Employees execute on behalf of their linked owner
  v_user := public.effective_owner_id();
  if v_user is null then
    raise exception 'No owner mapping for current user';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then

    raise exception 'Invoice needs at least one item';
  end if;

  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and user_id = v_user
  ) then
    raise exception 'Customer not found';
  end if;

  insert into public.invoice_counters(user_id, next_number)
  values (v_user, 2)
  on conflict (user_id)
  do update set next_number = public.invoice_counters.next_number + 1,
                updated_at = now()
  returning next_number - 1 into v_seq;

  v_invoice_no := 'INV-' || lpad(v_seq::text, 5, '0');

  insert into public.invoices (
    user_id, invoice_seq, invoice_no, customer_id, invoice_date, invoice_type, payment_mode
  )
  values (
    v_user, v_seq, v_invoice_no, p_customer_id, coalesce(p_invoice_date, current_date),
    coalesce(nullif(p_invoice_type, ''), 'tax_invoice'), coalesce(nullif(p_payment_mode, ''), 'Cash')
  )
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_qty := (v_item ->> 'quantity')::integer;
    v_price := (v_item ->> 'unit_price')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid item quantity';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Invalid item price';
    end if;

    select * into v_product
    from public.products
    where id = v_product_id and user_id = v_user
    for update;

    if not found then
      raise exception 'Product not found';
    end if;

    if v_variant_id is not null then
      select * into v_variant
      from public.product_variants
      where id = v_variant_id and product_id = v_product_id and user_id = v_user
      for update;

      if not found then
        raise exception 'Variant not found';
      end if;
      if v_variant.stock_qty < v_qty then
        raise exception 'Insufficient stock for %', v_product.name || ' - ' || v_variant.name;
      end if;

      update public.product_variants
      set stock_qty = stock_qty - v_qty
      where id = v_variant_id;
    else
      if v_product.stock_qty < v_qty then
        raise exception 'Insufficient stock for %', v_product.name;
      end if;
    end if;

    update public.products
    set stock_qty = stock_qty - v_qty
    where id = v_product_id;

    v_line_subtotal := round(v_qty * v_price, 2);
    v_line_gst := case
      when coalesce(p_invoice_type, '') = 'challan' then 0
      else round(v_line_subtotal * coalesce(v_product.gst_rate, 0) / 100, 2)
    end;
    v_line_total := v_line_subtotal + v_line_gst;

    v_subtotal := v_subtotal + v_line_subtotal;
    v_gst := v_gst + v_line_gst;
    v_total := v_total + v_line_total;

    insert into public.invoice_items (
      user_id, invoice_id, product_id, variant_id, product_name, variant_name, hsn,
      quantity, unit_price, gst_rate, line_subtotal, line_gst, line_total
    )
    values (
      v_user, v_invoice_id, v_product_id, v_variant_id, v_product.name,
      case when v_variant_id is null then null else v_variant.name end,
      v_product.hsn, v_qty, v_price, v_product.gst_rate,
      v_line_subtotal, v_line_gst, v_line_total
    );

    insert into public.stock_movements (
      user_id, product_id, variant_id, movement_type, quantity, source, notes, received_date
    )
    values (
      v_user, v_product_id, v_variant_id, 'sale', v_qty, v_invoice_no, 'Invoice sale', coalesce(p_invoice_date, current_date)
    );
  end loop;

  update public.invoices
  set subtotal = v_subtotal,
      gst_total = v_gst,
      total = v_total
  where id = v_invoice_id;

  return v_invoice_id;
exception
  when others then
    raise;
end;
$$;

-- Employees need to execute stock receive + invoice creation on behalf of the linked owner
grant execute on function public.receive_stock(uuid, uuid, integer, text, text, date) to authenticated;
grant execute on function public.create_invoice(uuid, date, text, text, jsonb) to authenticated;
grant execute on function public.delete_invoice_and_restore_stock(uuid) to authenticated;

-- =========================
-- RPC: delete invoice and restore stock
-- =========================
-- Restores the quantities deducted during create_invoice() back into products / product_variants.
create or replace function public.delete_invoice_and_restore_stock(
  p_invoice_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_inv public.invoices%rowtype;
  v_item record;
  v_invoice_no text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  -- Employees operate on the linked owner's data
  v_owner := public.effective_owner_id();
  if v_owner is null then
    raise exception 'No owner mapping for current user';
  end if;

  select * into v_inv
  from public.invoices
  where id = p_invoice_id and user_id = v_owner;

  if not found then
    raise exception 'Invoice not found';
  end if;

  v_invoice_no := v_inv.invoice_no;

  -- Restore stock back for each invoice item
  -- Note: Some invoices may have variant_id = NULL even when a variant was chosen.
  -- In that case, try to resolve variant by (product_id + variant_name).
  for v_item in
    select *
    from public.invoice_items
    where invoice_id = p_invoice_id and user_id = v_owner
  loop
    if v_item.variant_id is not null then
      update public.product_variants
      set stock_qty = stock_qty + v_item.quantity
      where id = v_item.variant_id;

      insert into public.stock_movements (
        user_id, product_id, variant_id, movement_type, quantity, source, notes, received_date
      ) values (
        v_owner, v_item.product_id, v_item.variant_id, 'adjustment', v_item.quantity,
        v_invoice_no, 'Invoice deleted — stock returned', coalesce(v_inv.invoice_date, current_date)
      );
    else
      -- Try resolve variant_id from variant_name
      if v_item.variant_name is not null and btrim(v_item.variant_name) <> '' then
        declare
          v_resolved_variant_id uuid;
        begin
          select id into v_resolved_variant_id
          from public.product_variants
          where product_id = v_item.product_id
            and user_id = v_owner
            and name = v_item.variant_name
          limit 1;

          if v_resolved_variant_id is not null then
            update public.product_variants
            set stock_qty = stock_qty + v_item.quantity
            where id = v_resolved_variant_id;

            insert into public.stock_movements (
              user_id, product_id, variant_id, movement_type, quantity, source, notes, received_date
            ) values (
              v_owner, v_item.product_id, v_resolved_variant_id, 'adjustment', v_item.quantity,
              v_invoice_no, 'Invoice deleted — stock returned', coalesce(v_inv.invoice_date, current_date)
            );
          else
            -- Fallback: restore to base product stock
            update public.products
            set stock_qty = stock_qty + v_item.quantity
            where id = v_item.product_id;

            insert into public.stock_movements (
              user_id, product_id, variant_id, movement_type, quantity, source, notes, received_date
            ) values (
              v_owner, v_item.product_id, null, 'adjustment', v_item.quantity,
              v_invoice_no, 'Invoice deleted — stock returned', coalesce(v_inv.invoice_date, current_date)
            );
          end if;
        end;
      else
        -- No variant_name either: restore to base product stock
        update public.products
        set stock_qty = stock_qty + v_item.quantity
        where id = v_item.product_id;

        insert into public.stock_movements (
          user_id, product_id, variant_id, movement_type, quantity, source, notes, received_date
        ) values (
          v_owner, v_item.product_id, null, 'adjustment', v_item.quantity,
          v_invoice_no, 'Invoice deleted — stock returned', coalesce(v_inv.invoice_date, current_date)
        );
      end if;
    end if;
  end loop;

  -- Delete invoice items + invoice header
  delete from public.invoice_items where invoice_id = p_invoice_id and user_id = v_owner;
  delete from public.invoices where id = p_invoice_id and user_id = v_owner;
end;
$$;

notify pgrst, 'reload schema';

