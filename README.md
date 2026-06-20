# SmartBuzz Inventory

SmartBuzz is a clean Supabase-backed inventory and GST billing app for small businesses.

## Setup

1. Create a new Supabase project.
2. Open Supabase SQL Editor and run `supabase-schema.sql`.
3. Enable Email auth in Supabase Authentication settings.
4. Open `index.html` in a browser.
5. Paste your Supabase Project URL and anon public key on the connection screen.
6. Create an account and start adding products, stock, customers, and invoices.

No Supabase Edge Function is needed. Stock receiving and invoice creation use Postgres RPC functions inside `supabase-schema.sql`, so stock and invoices update transactionally.

## Files

- `index.html` - app shell and views.
- `styles.css` - clean responsive dashboard styling and loading states.
- `app.js` - Supabase auth, CRUD, billing, reports, and rendering.
- `supabase-schema.sql` - database schema, RLS policies, triggers, and RPC functions.
