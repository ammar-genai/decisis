// Hypothesis phrasings for @decisis/local on the routing questions.
//
// The router's own `criteria` are instructions to a large model. An NLI model does not read
// instructions: it scores whether the task text entails each phrase, so each phrase has to be a
// natural completion of "This example is {}." Same questions, same policy, different wording.
export const LOCAL_LABELS = {
  tier: {
    haiku: 'a mechanical, local, fully specified change such as a rename, a typo fix, a formatting or config tweak, or a simple test or docs edit',
    sonnet: 'normal engineering work inside the existing architecture, such as adding a feature, fixing a bug, or writing tests',
    opus: 'hard or high-stakes work such as a data migration, a security or permissions change, a cross-cutting refactor, concurrency, performance, or debugging an unknown cause',
  },
  complexity: [
    'a trivial change that touches one or two files',
    'a small change with a clear approach',
    'a moderately involved change across several files',
    'a hard change requiring design decisions',
    'a very hard change across the whole system',
  ],
  risk: [
    'harmless if it is wrong, and obvious straight away',
    'moderately costly if it is wrong',
    'expensive or hard to detect if it is wrong, such as data loss or a security hole',
  ],
  ambiguity: {
    true: 'under-specified, leaving open questions about the approach, the interfaces or the behaviour',
    false: 'fully specified, leaving only the implementation',
  },
};
