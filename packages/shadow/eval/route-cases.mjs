// Labelled routing briefs against eval/sample-crew-dispatch.json (rules 1-3 from firstmate's
// docs/examples/crew-dispatch.json plus a captain-approval rule 4).
export default [
  { id: 'news', brief: 'Summarise what changed in this week\'s Node.js 26.3 release and whether any of it affects our build.', expect: ['rule_1'] },
  { id: 'typo', brief: 'Fix the typo "recieve" -> "receive" across the docs/ folder.', expect: ['rule_2'] },
  { id: 'rename', brief: 'Rename the helper formatCurrencyOld to formatCurrency in src/utils and update its 4 call sites.', expect: ['rule_2'] },
  { id: 'big-feature', brief: 'Design and implement offline mode for the mobile app: local cache, sync queue, conflict resolution, and UI states across ~30 files.', expect: ['rule_3'] },
  { id: 'risky-refactor', brief: 'Replace our hand-rolled event bus with the new message broker across all services without downtime.', expect: ['rule_3'] },
  { id: 'auth', brief: 'Rotate the JWT signing secret and add support for two active keys during rollover.', expect: ['rule_4'] },
  { id: 'payments', brief: 'Add Apple Pay as a checkout payment method in the Stripe integration.', expect: ['rule_4'] },
  { id: 'medium-bug', brief: 'The CSV export drops rows whose name contains a comma. Fix it and add a test.', expect: ['default'] },
  { id: 'scout', brief: 'Investigate why the nightly job sometimes runs twice and write up what you find.', expect: ['default'] },
];
