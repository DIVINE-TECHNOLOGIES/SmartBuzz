-- Supabase schema for multi-tenant GST Business Manager (SmartBuzz Pro)

-- =========================
-- Extensions
-- =========================
create extension if not exists pgcrypto;

-- =========================
-- Helper Function
-- =========================
create or replace function public.set_user_id()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;

  return new;
end;
$$;

-- =========================
-- business_profiles
-- =========================
create table if not exists public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null default '',
  gstin text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  state text not null default '',
  state_code text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Drop existing trigger safely
drop trigger if exists set_business_profiles_user_id
on public.business_profiles;

create trigger set_business_profiles_user_id
before insert on public.business_profiles
for each row
execute function public.set_user_id();

-- =========================
-- products
-- =========================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  sku text not null,
  category text not null default 'General',
  mrp numeric(12,2) not null default 0,
  price numeric(12,2) not null default 0,
  purchase numeric(12,2) not null default 0,
  stock integer not null default 0,
  gst smallint not null default 12,
  hsn text,
  expiry date,
  manufacturer text,
  unit text not null default 'pcs',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  variants jsonb not null default '[]'::jsonb,
  unique(user_id, sku)

);

-- Existing Supabase projects created before variants were added need this migration.
alter table public.products
add column if not exists variants jsonb not null default '[]'::jsonb;

alter table public.products
alter column variants set default '[]'::jsonb;

update public.products
set variants = '[]'::jsonb
where variants is null;

alter table public.products
alter column variants set not null;

-- Drop existing trigger safely
drop trigger if exists set_products_user_id
on public.products;

create trigger set_products_user_id
before insert on public.products
for each row
execute function public.set_user_id();

-- =========================
-- customers
-- =========================
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  phone text not null,
  email text,
  gstin text,
  city text,
  address text,
  purchases uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, phone)
);

drop trigger if exists set_customers_user_id
on public.customers;

create trigger set_customers_user_id
before insert on public.customers
for each row
execute function public.set_user_id();

-- =========================
-- sales
-- =========================
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  inv_no text not null,
  customer_id uuid,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) not null default 0,
  gst numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  sale_date date not null,
  payment_mode text not null default 'Cash',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, inv_no)
);

drop trigger if exists set_sales_user_id
on public.sales;

create trigger set_sales_user_id
before insert on public.sales
for each row
execute function public.set_user_id();

-- =========================
-- bills
-- =========================
create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  inv_no text not null,
  customer_id uuid,
  amount numeric(12,2) not null default 0,
  bill_date date not null,
  format text not null default 'Standard GST Invoice',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, inv_no)
);

drop trigger if exists set_bills_user_id
on public.bills;

create trigger set_bills_user_id
before insert on public.bills
for each row
execute function public.set_user_id();

-- =========================
-- wa_log
-- =========================
create table if not exists public.wa_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  customer text,
  phone text,
  product text,
  time text,
  url text,
  created_at timestamptz not null default now()
);

drop trigger if exists set_wa_log_user_id
on public.wa_log;

create trigger set_wa_log_user_id
before insert on public.wa_log
for each row
execute function public.set_user_id();

-- =========================
-- invoice_counters
-- =========================
create table if not exists public.invoice_counters (
  user_id uuid primary key,
  counter integer not null default 1,
  updated_at timestamptz not null default now()
);

-- =========================
-- Enable RLS
-- =========================
alter table public.business_profiles enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.bills enable row level security;
alter table public.wa_log enable row level security;

-- =========================
-- Remove old policies safely
-- =========================

-- business_profiles
drop policy if exists "bp_read_own" on public.business_profiles;
drop policy if exists "bp_write_own" on public.business_profiles;
drop policy if exists "bp_update_own" on public.business_profiles;

-- products
drop policy if exists "products_read_own" on public.products;
drop policy if exists "products_insert_own" on public.products;
drop policy if exists "products_update_own" on public.products;
drop policy if exists "products_delete_own" on public.products;

-- customers
drop policy if exists "customers_read_own" on public.customers;
drop policy if exists "customers_insert_own" on public.customers;
drop policy if exists "customers_update_own" on public.customers;
drop policy if exists "customers_delete_own" on public.customers;

-- sales
drop policy if exists "sales_read_own" on public.sales;
drop policy if exists "sales_insert_own" on public.sales;
drop policy if exists "sales_update_own" on public.sales;
drop policy if exists "sales_delete_own" on public.sales;

-- bills
drop policy if exists "bills_read_own" on public.bills;
drop policy if exists "bills_insert_own" on public.bills;
drop policy if exists "bills_update_own" on public.bills;
drop policy if exists "bills_delete_own" on public.bills;

-- wa_log
drop policy if exists "wa_read_own" on public.wa_log;
drop policy if exists "wa_insert_own" on public.wa_log;
drop policy if exists "wa_delete_own" on public.wa_log;

-- =========================
-- business_profiles policies
-- =========================
create policy "bp_read_own"
on public.business_profiles
for select
using (user_id = auth.uid());

create policy "bp_write_own"
on public.business_profiles
for insert
with check (user_id = auth.uid());

create policy "bp_update_own"
on public.business_profiles
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- =========================
-- products policies
-- =========================
create policy "products_read_own"
on public.products
for select
using (user_id = auth.uid());

create policy "products_insert_own"
on public.products
for insert
with check (user_id = auth.uid());

create policy "products_update_own"
on public.products
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "products_delete_own"
on public.products
for delete
using (user_id = auth.uid());

-- =========================
-- customers policies
-- =========================
create policy "customers_read_own"
on public.customers
for select
using (user_id = auth.uid());

create policy "customers_insert_own"
on public.customers
for insert
with check (user_id = auth.uid());

create policy "customers_update_own"
on public.customers
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "customers_delete_own"
on public.customers
for delete
using (user_id = auth.uid());

-- =========================
-- sales policies
-- =========================
create policy "sales_read_own"
on public.sales
for select
using (user_id = auth.uid());

create policy "sales_insert_own"
on public.sales
for insert
with check (user_id = auth.uid());

create policy "sales_update_own"
on public.sales
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "sales_delete_own"
on public.sales
for delete
using (user_id = auth.uid());

-- =========================
-- bills policies
-- =========================
create policy "bills_read_own"
on public.bills
for select
using (user_id = auth.uid());

create policy "bills_insert_own"
on public.bills
for insert
with check (user_id = auth.uid());

create policy "bills_update_own"
on public.bills
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "bills_delete_own"
on public.bills
for delete
using (user_id = auth.uid());

-- =========================
-- wa_log policies
-- =========================
create policy "wa_read_own"
on public.wa_log
for select
using (user_id = auth.uid());

create policy "wa_insert_own"
on public.wa_log
for insert
with check (user_id = auth.uid());

create policy "wa_delete_own"
on public.wa_log
for delete
using (user_id = auth.uid());

-- =========================
-- Indexes
-- =========================
create index if not exists products_user_stock_idx
on public.products(user_id, stock);

create index if not exists products_user_expiry_idx
on public.products(user_id, expiry);

create index if not exists customers_user_phone_idx
on public.customers(user_id, phone);

create index if not exists sales_user_date_idx
on public.sales(user_id, sale_date);

create index if not exists bills_user_date_idx
on public.bills(user_id, bill_date);

-- Refresh PostgREST schema cache after adding columns/policies.
notify pgrst, 'reload schema';
