// Labelled routing cases for a large e-commerce monorepo (TypeScript services + React web app + Postgres).
// `ideal` is the tier a careful tech lead would pick; `ok` lists every acceptable tier.
// Routing below min(ok) is UNDER-routing (quality risk); above max(ok) is OVER-routing (cost only).
const H = 'haiku', S = 'sonnet', O = 'opus';
const c = (id, title, description, files, ideal, ok) => ({ id, task: { title, description, files, depends_on: [], acceptance: null }, ideal, ok });

export const PROJECT = {
  goal: 'Ongoing development of an e-commerce platform',
  summary: 'Monorepo: services/orders, services/payments, services/catalog (Node/TypeScript, Postgres via Prisma), apps/web (React), shared/libs. Jest tests, GitHub Actions CI.',
};

export default [
  // Mechanical, local, fully specified -> haiku
  c('rename', 'Rename formatCurrencyOld to formatCurrency', 'Rename the helper formatCurrencyOld in shared/libs/money.ts to formatCurrency and update its 4 call sites.', ['shared/libs/money.ts'], H, [H, S]),
  c('typo', 'Fix typos in checkout copy', 'Fix "recieve" -> "receive" and "adress" -> "address" in apps/web/src/checkout/copy.ts.', ['apps/web/src/checkout/copy.ts'], H, [H]),
  c('lint', 'Apply prettier to services/catalog', 'Run prettier on services/catalog/src and commit only formatting changes.', ['services/catalog/src'], H, [H]),
  c('envdoc', 'Document env vars in README', 'Add a table of the 6 environment variables read in services/orders/src/config.ts to services/orders/README.md.', ['services/orders/src/config.ts', 'services/orders/README.md'], H, [H, S]),
  c('bumpdep', 'Bump lodash patch version', 'Bump lodash from 4.17.20 to 4.17.21 in services/catalog/package.json and update the lockfile.', ['services/catalog/package.json'], H, [H]),
  c('const', 'Extract magic number to constant', 'In services/orders/src/cart.ts replace the literal 30 (cart expiry minutes) with a named constant CART_EXPIRY_MINUTES.', ['services/orders/src/cart.ts'], H, [H]),
  c('testcase', 'Add test for empty cart total', 'Add a Jest test asserting cartTotal([]) returns 0 in services/orders/test/cart.test.ts, following the existing test style.', ['services/orders/test/cart.test.ts'], H, [H, S]),
  c('log', 'Add log line on order creation', 'Add an info log with orderId and itemCount after an order is created in services/orders/src/createOrder.ts using the existing logger.', ['services/orders/src/createOrder.ts'], H, [H]),
  c('i18n', 'Add French strings for footer', 'Add the 5 footer keys that exist in apps/web/src/i18n/en.json to fr.json with provided translations: (list given in ticket).', ['apps/web/src/i18n/fr.json'], H, [H]),
  c('ciflag', 'Enable Node 22 in CI matrix', 'Add node 22 to the matrix in .github/workflows/ci.yml next to 20.', ['.github/workflows/ci.yml'], H, [H, S]),

  // Typical feature / bug work within existing architecture -> sonnet
  c('health', 'Add /health endpoint', 'Add GET /health to services/orders returning build version and DB connectivity, with a test.', ['services/orders/src/routes.ts'], S, [S]),
  c('pagination', 'Paginate order history API', 'Add cursor-based pagination to GET /orders in services/orders; keep the old response shape when no cursor is passed; update tests.', ['services/orders/src/routes.ts', 'services/orders/src/repo.ts'], S, [S, O]),
  c('bugnull', 'Fix crash when product has no image', 'apps/web ProductCard throws when product.images is empty. Show the placeholder image instead and add a test.', ['apps/web/src/catalog/ProductCard.tsx'], S, [S, H]),
  c('filter', 'Add price range filter to catalog search', 'Add minPrice/maxPrice query params to GET /products search in services/catalog, validate them, include in the Prisma query, and add tests.', ['services/catalog/src/search.ts'], S, [S]),
  c('email', 'Send order confirmation email', 'After successful payment, send the existing OrderConfirmation template via the email client in shared/libs/email.ts. Add a test with the client mocked.', ['services/orders/src/createOrder.ts', 'shared/libs/email.ts'], S, [S]),
  c('form', 'Validate address form', 'Add client-side validation (required fields, postcode format per country list) to apps/web AddressForm with error messages and tests.', ['apps/web/src/checkout/AddressForm.tsx'], S, [S]),
  c('flaky', 'Fix flaky catalog search test', 'services/catalog/test/search.test.ts fails ~1 in 10 runs in CI with ordering differences. Find the cause and make it deterministic.', ['services/catalog/test/search.test.ts'], S, [S, O]),
  c('retry', 'Add retry to inventory client', 'Wrap calls in shared/libs/inventoryClient.ts with exponential backoff retries (3 attempts, only on 5xx/timeouts) and tests.', ['shared/libs/inventoryClient.ts'], S, [S]),
  c('csv', 'Export orders as CSV', 'Add an admin endpoint that streams all orders in a date range as CSV (escaping commas/quotes correctly), with tests.', ['services/orders/src/admin.ts'], S, [S]),
  c('coupon', 'Support percentage coupons', 'Coupons currently support fixed amounts only. Add percentage coupons (capped at 100%) to the discount calculation and its tests.', ['services/orders/src/discounts.ts'], S, [S, O]),
  c('upgrade', 'Upgrade React Router v6 to v7 in web app', 'Upgrade apps/web from react-router 6 to 7 following the official migration guide; fix the ~15 route definitions and loaders; keep tests green.', ['apps/web/src/routes'], S, [S, O]),
  c('a11y', 'Fix accessibility issues on checkout page', 'Resolve the 8 axe violations reported on the checkout page (labels, contrast, focus order) and add an axe test.', ['apps/web/src/checkout'], S, [S]),

  // Hard or high-stakes -> opus
  c('migration', 'Split orders table without downtime', 'Design and implement a zero-downtime migration splitting orders into orders and order_items: dual writes, backfill, cutover and rollback plan.', ['services/orders/prisma/schema.prisma'], O, [O]),
  c('race', 'Fix double-charge race in payments', 'Customers are occasionally charged twice when they double-click Pay. Find the race between the web app, orders and payments services and fix it with idempotency.', ['services/payments', 'services/orders', 'apps/web/src/checkout'], O, [O]),
  c('authz', 'Add role-based access control to admin APIs', 'Design and implement RBAC for all admin endpoints across the three services: roles, permission checks, token claims, audit logging, and tests.', ['services/*/src/admin.ts', 'shared/libs/auth.ts'], O, [O, S]),
  c('perf', 'Cut catalog search p95 from 1.8s to 300ms', 'Catalog search p95 is 1.8s under load. Profile, find the bottleneck (queries, indexes, N+1, caching) and bring p95 under 300ms without stale prices.', ['services/catalog'], O, [O]),
  c('arch', 'Design event bus between services', 'Replace synchronous HTTP calls between orders, payments and inventory with an event-driven design. Propose the architecture, message schemas, delivery guarantees and a phased migration.', ['services'], O, [O]),
  c('memleak', 'Find memory leak in orders service', 'services/orders memory grows ~200MB/day in production until it is restarted. No obvious cause. Investigate and fix.', ['services/orders'], O, [O, S]),
  c('pci', 'Remove card data from logs', 'An audit found partial card numbers in logs. Find every path that can log payment data across services and libraries, redact it, and add guards so it cannot recur.', ['services/payments', 'shared/libs/logger.ts'], O, [O]),
  c('tax', 'Multi-country tax engine', 'Replace the flat 8% tax with per-country VAT/GST rules including rounding rules, tax-inclusive prices for EU, and exemptions; ambiguous requirements to be clarified.', ['services/orders/src/tax.ts'], O, [O]),
];
