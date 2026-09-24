# Contributing

```sh
npm install
npm test        # every adapter takes an injectable fetch; tests never touch the network
npm run typecheck
```

Node 22.18 or newer, which is where Node began running TypeScript without a flag. There is no build step: the packages ship TypeScript that Node runs directly.

A few house rules that keep this library predictable:

- **Policy only ever moves a decision towards the safer end of a ladder.** If a change can lower a decision without a human asking for it, it is a bug.
- **Every decision records its reasons.** A new rule adds to `reasons`; nothing decides silently.
- **A model failure degrades safely and says so.** Never quietly fall through to the cheap branch.
- **Tests stay offline and deterministic.** Inject `fetch`, a decider, or a child process; never call a provider from a test.
- **New behaviour comes with a labelled case** where accuracy matters, so it can be measured rather than argued about.
