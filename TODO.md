# Sales Report Implementation TODO

## Approved Plan Steps

### 1. [x] Add Navigation Item ✅
- Inserted new nav item: 📚 Sales Report under Billing section.

### 2. [x] Create New Page Structure ✅
- Added `#page-report` placeholder page.

### 3. [x] Add CSS Styles ✅
- Added `.report-preview` styles and print media query enhancements.

### 4. [ ] JavaScript Functions
- [ ] `renderSalesReport()` / report preview logic
- [ ] `getSalesReportHTML()` (or equivalent)
- [ ] integrate into `navigate()`, `renderPage()`

### 5. [ ] Update Existing Functions
- [ ] Update `populateCustomerDropdowns()` for report filters

### 6. [ ] Test & Complete
- [ ] Navigate/test report generation/print
- [ ] Mark complete

**Progress: 2/6**

---

# Supabase Backend Migration (New)

## Plan
1. [x] Create Supabase schema (multi-tenant)
2. [x] Enable RLS + policies
3. [x] Add Edge Function for atomic stock decrement on sale/bill
4. [x] Replace localStorage data layer with Supabase CRUD (partial; products/customers)
5. [x] Update UI to load render from Supabase
6. [ ] Log WhatsApp alerts to DB
7. [ ] QA: concurrency + stock correctness
8. [ ] Update README / deployment notes (if any)


